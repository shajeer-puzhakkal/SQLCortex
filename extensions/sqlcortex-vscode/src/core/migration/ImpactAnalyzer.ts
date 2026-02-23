import type {
  MigrationDiff,
  MigrationDiffColumnChange,
  MigrationDiffConstraintChange,
} from "./MigrationDiffBuilder";
import { toSchemaGraphTableId, type SchemaGraph, type SchemaGraphForeignKeyEdge } from "../schema/SchemaGraph";
import type { SchemaSnapshot, SchemaSnapshotIndex, SchemaSnapshotSchema } from "../schema/SchemaTypes";

export type ImpactReport = {
  directImpact: string[];
  indirectImpact: string[];
  brokenObjects: string[];
};

type ImpactAnalyzerInput = {
  migrationDiff: MigrationDiff;
  schemaGraph: SchemaGraph;
  snapshotBefore: SchemaSnapshot;
};

type DefinitionObjectKind = "view" | "function" | "procedure" | "routine" | "trigger";

type DefinitionObject = {
  kind: DefinitionObjectKind;
  schemaName: string;
  name: string;
  definition: string | null;
  signature: string | null;
  tableName: string | null;
  columns: string[];
  label: string;
};

type TriggerDefinition = {
  name: string;
  definition: string | null;
  tableName: string | null;
  columns: string[];
};

type ImpactAccumulator = {
  directImpact: Set<string>;
  indirectImpact: Set<string>;
  brokenObjects: Set<string>;
  directTableIds: Set<string>;
};

const ROUTINE_KINDS = ["function", "procedure", "routine"] as const;

export function analyzeDependencyImpact(input: ImpactAnalyzerInput): ImpactReport {
  const accumulator: ImpactAccumulator = {
    directImpact: new Set<string>(),
    indirectImpact: new Set<string>(),
    brokenObjects: new Set<string>(),
    directTableIds: new Set<string>(),
  };
  const definitionObjects = collectDefinitionObjects(input.snapshotBefore);

  for (const removedTable of input.migrationDiff.tablesRemoved) {
    const ref = parseQualifiedTableName(removedTable);
    if (!ref) {
      continue;
    }
    markDirectTableImpact(accumulator, ref.schemaName, ref.tableName);
    markTableDependencies({
      accumulator,
      schemaGraph: input.schemaGraph,
      snapshotBefore: input.snapshotBefore,
      schemaName: ref.schemaName,
      tableName: ref.tableName,
      definitionObjects,
      markAsBroken: true,
    });
  }

  for (const change of input.migrationDiff.columnsRemoved) {
    markDirectTableImpact(accumulator, change.schemaName, change.tableName);
    markColumnDependencies({
      accumulator,
      schemaGraph: input.schemaGraph,
      snapshotBefore: input.snapshotBefore,
      change,
      definitionObjects,
      markAsBroken: true,
      detectIndexImpact: true,
      detectForeignKeyImpact: true,
    });
  }

  for (const change of input.migrationDiff.columnsAltered) {
    markDirectTableImpact(accumulator, change.schemaName, change.tableName);
    const typeChanged = hasColumnTypeChanged(change);
    markColumnDependencies({
      accumulator,
      schemaGraph: input.schemaGraph,
      snapshotBefore: input.snapshotBefore,
      change,
      definitionObjects,
      markAsBroken: false,
      detectIndexImpact: typeChanged,
      detectForeignKeyImpact: true,
    });
  }

  for (const change of input.migrationDiff.constraintsChanged) {
    markConstraintImpact(accumulator, change);
  }

  collectIndirectTableImpact(accumulator, input.schemaGraph);

  return {
    directImpact: sortValues(accumulator.directImpact),
    indirectImpact: sortValues(accumulator.indirectImpact),
    brokenObjects: sortValues(accumulator.brokenObjects),
  };
}

function markTableDependencies(input: {
  accumulator: ImpactAccumulator;
  schemaGraph: SchemaGraph;
  snapshotBefore: SchemaSnapshot;
  schemaName: string;
  tableName: string;
  definitionObjects: DefinitionObject[];
  markAsBroken: boolean;
}): void {
  markDefinitionObjectImpacts({
    accumulator: input.accumulator,
    definitionObjects: input.definitionObjects,
    schemaName: input.schemaName,
    tableName: input.tableName,
    columnName: null,
    markAsBroken: input.markAsBroken,
  });

  const tableId = toSchemaGraphTableId(input.schemaName, input.tableName);
  const edges = collectForeignKeyEdgesForTable(input.schemaGraph, tableId);
  for (const edge of edges) {
    const label = formatForeignKeyImpact(edge);
    input.accumulator.directImpact.add(label);
    if (input.markAsBroken) {
      input.accumulator.brokenObjects.add(label);
    }
  }

  const indexes = collectIndexesForTable(input.schemaGraph, input.snapshotBefore, tableId);
  for (const index of indexes) {
    const label = formatIndexImpact(input.schemaName, input.tableName, index.name);
    input.accumulator.directImpact.add(label);
    if (input.markAsBroken) {
      input.accumulator.brokenObjects.add(label);
    }
  }
}

function markColumnDependencies(input: {
  accumulator: ImpactAccumulator;
  schemaGraph: SchemaGraph;
  snapshotBefore: SchemaSnapshot;
  change: MigrationDiffColumnChange;
  definitionObjects: DefinitionObject[];
  markAsBroken: boolean;
  detectIndexImpact: boolean;
  detectForeignKeyImpact: boolean;
}): void {
  markDefinitionObjectImpacts({
    accumulator: input.accumulator,
    definitionObjects: input.definitionObjects,
    schemaName: input.change.schemaName,
    tableName: input.change.tableName,
    columnName: input.change.columnName,
    markAsBroken: input.markAsBroken,
  });

  const tableId = toSchemaGraphTableId(input.change.schemaName, input.change.tableName);

  if (input.detectIndexImpact) {
    const indexes = collectIndexesForColumn(
      input.schemaGraph,
      input.snapshotBefore,
      tableId,
      input.change.schemaName,
      input.change.tableName,
      input.change.columnName
    );
    for (const index of indexes) {
      const label = formatIndexImpact(input.change.schemaName, input.change.tableName, index.name);
      input.accumulator.directImpact.add(label);
      if (input.markAsBroken) {
        input.accumulator.brokenObjects.add(label);
      }
    }
  }

  if (input.detectForeignKeyImpact) {
    const edges = collectForeignKeyEdgesForColumn(input.schemaGraph, tableId, input.change.columnName);
    for (const edge of edges) {
      const label = formatForeignKeyImpact(edge);
      input.accumulator.directImpact.add(label);
      if (input.markAsBroken) {
        input.accumulator.brokenObjects.add(label);
      }
    }
  }
}

function markConstraintImpact(
  accumulator: ImpactAccumulator,
  constraintChange: MigrationDiffConstraintChange
): void {
  if (constraintChange.source !== "foreignKey") {
    return;
  }
  markDirectTableImpact(accumulator, constraintChange.schemaName, constraintChange.tableName);
  const label = `foreign_key ${constraintChange.schemaName}.${constraintChange.tableName}.${constraintChange.constraintName}`;
  accumulator.directImpact.add(label);
  if (constraintChange.kind !== "added") {
    accumulator.brokenObjects.add(label);
  }
}

function collectIndirectTableImpact(accumulator: ImpactAccumulator, schemaGraph: SchemaGraph): void {
  if (accumulator.directTableIds.size === 0) {
    return;
  }

  const visited = new Set<string>(accumulator.directTableIds);
  const queue = Array.from(accumulator.directTableIds.values());

  while (queue.length > 0) {
    const currentTableId = queue.shift();
    if (!currentTableId) {
      continue;
    }
    const node = schemaGraph.tables[currentTableId];
    if (!node) {
      continue;
    }

    for (const ref of [...node.dependencies, ...node.dependents]) {
      if (visited.has(ref.id)) {
        continue;
      }
      visited.add(ref.id);
      queue.push(ref.id);
    }
  }

  for (const tableId of visited) {
    if (accumulator.directTableIds.has(tableId)) {
      continue;
    }
    const node = schemaGraph.tables[tableId];
    if (!node) {
      continue;
    }
    accumulator.indirectImpact.add(formatTableImpact(node.ref.schemaName, node.ref.tableName));
  }
}

function markDirectTableImpact(
  accumulator: ImpactAccumulator,
  schemaName: string,
  tableName: string
): void {
  accumulator.directTableIds.add(toSchemaGraphTableId(schemaName, tableName));
  accumulator.directImpact.add(formatTableImpact(schemaName, tableName));
}

function markDefinitionObjectImpacts(input: {
  accumulator: ImpactAccumulator;
  definitionObjects: DefinitionObject[];
  schemaName: string;
  tableName: string;
  columnName: string | null;
  markAsBroken: boolean;
}): void {
  for (const object of input.definitionObjects) {
    if (!definitionObjectReferencesTable(object, input.schemaName, input.tableName)) {
      continue;
    }
    if (
      input.columnName &&
      !definitionObjectReferencesColumn(object, input.schemaName, input.tableName, input.columnName)
    ) {
      continue;
    }
    input.accumulator.directImpact.add(object.label);
    if (input.markAsBroken) {
      input.accumulator.brokenObjects.add(object.label);
    }
  }
}

function definitionObjectReferencesTable(
  object: DefinitionObject,
  schemaName: string,
  tableName: string
): boolean {
  if (object.kind === "trigger" && object.tableName && identifiersEqual(object.tableName, tableName)) {
    if (!object.definition) {
      return true;
    }
  }
  if (!object.definition) {
    return false;
  }
  return containsTableReference(object.definition, schemaName, tableName);
}

function definitionObjectReferencesColumn(
  object: DefinitionObject,
  schemaName: string,
  tableName: string,
  columnName: string
): boolean {
  if (object.kind === "trigger" && object.columns.length > 0) {
    for (const triggerColumn of object.columns) {
      if (identifiersEqual(triggerColumn, columnName)) {
        return true;
      }
    }
  }
  if (!object.definition) {
    return false;
  }
  if (!containsTableReference(object.definition, schemaName, tableName)) {
    return false;
  }
  return (
    containsQualifiedColumnReference(object.definition, schemaName, tableName, columnName) ||
    containsIdentifier(object.definition, columnName)
  );
}

function collectDefinitionObjects(snapshot: SchemaSnapshot): DefinitionObject[] {
  const objects: DefinitionObject[] = [];
  const seen = new Set<string>();

  const pushObject = (nextObject: DefinitionObject): void => {
    const dedupeKey = [
      nextObject.kind,
      nextObject.schemaName,
      nextObject.name,
      nextObject.signature ?? "",
      nextObject.tableName ?? "",
    ].join("::");
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    objects.push(nextObject);
  };

  for (const schema of snapshot.schemas) {
    for (const view of schema.views) {
      pushObject({
        kind: "view",
        schemaName: schema.name,
        name: view.name,
        definition: view.definition,
        signature: null,
        tableName: null,
        columns: [],
        label: `view ${schema.name}.${view.name}`,
      });
    }

    for (const kind of ROUTINE_KINDS) {
      for (const routine of listRoutinesForKind(schema, kind)) {
        const signatureSuffix = routine.signature ? routine.signature : "";
        const routineLabelName = signatureSuffix ? `${routine.name}${signatureSuffix}` : routine.name;
        pushObject({
          kind,
          schemaName: schema.name,
          name: routine.name,
          definition: routine.definition,
          signature: routine.signature,
          tableName: null,
          columns: [],
          label: `${kind} ${schema.name}.${routineLabelName}`,
        });
      }
    }

    for (const trigger of readSchemaTriggers(schema)) {
      pushObject({
        kind: "trigger",
        schemaName: schema.name,
        name: trigger.name,
        definition: trigger.definition,
        signature: null,
        tableName: trigger.tableName,
        columns: trigger.columns,
        label: `trigger ${schema.name}.${trigger.name}`,
      });
    }
  }

  return objects;
}

function listRoutinesForKind(
  schema: SchemaSnapshotSchema,
  kind: "function" | "procedure" | "routine"
): SchemaSnapshotSchema["routines"] {
  if (kind === "function") {
    return schema.functions;
  }
  if (kind === "procedure") {
    return schema.procedures;
  }
  return schema.routines;
}

function readSchemaTriggers(schema: SchemaSnapshotSchema): TriggerDefinition[] {
  const rawTriggers = (schema as unknown as { triggers?: unknown }).triggers;
  if (!Array.isArray(rawTriggers)) {
    return [];
  }

  const triggers: TriggerDefinition[] = [];
  for (const rawTrigger of rawTriggers) {
    const record = asRecord(rawTrigger);
    if (!record) {
      continue;
    }
    const name = asString(record.name);
    if (!name) {
      continue;
    }
    triggers.push({
      name,
      definition: asNullableString(record.definition),
      tableName: asString(record.tableName ?? record.table ?? record.relationName ?? record.onTable),
      columns: asStringArray(record.columns),
    });
  }

  return triggers;
}

function collectForeignKeyEdgesForTable(
  schemaGraph: SchemaGraph,
  tableId: string
): SchemaGraphForeignKeyEdge[] {
  const edgeById = new Map<string, SchemaGraphForeignKeyEdge>();
  const outgoing = schemaGraph.outgoingForeignKeysByTable[tableId] ?? [];
  const incoming = schemaGraph.incomingForeignKeysByTable[tableId] ?? [];
  for (const edge of [...outgoing, ...incoming]) {
    edgeById.set(edge.id, edge);
  }
  return Array.from(edgeById.values());
}

function collectForeignKeyEdgesForColumn(
  schemaGraph: SchemaGraph,
  tableId: string,
  columnName: string
): SchemaGraphForeignKeyEdge[] {
  const edgeById = new Map<string, SchemaGraphForeignKeyEdge>();
  const normalizedColumn = normalizeIdentifier(columnName);
  const outgoing = schemaGraph.outgoingForeignKeysByTable[tableId] ?? [];
  const incoming = schemaGraph.incomingForeignKeysByTable[tableId] ?? [];

  for (const edge of outgoing) {
    if (edge.columns.some((column) => normalizeIdentifier(column) === normalizedColumn)) {
      edgeById.set(edge.id, edge);
    }
  }
  for (const edge of incoming) {
    if (edge.referencedColumns.some((column) => normalizeIdentifier(column) === normalizedColumn)) {
      edgeById.set(edge.id, edge);
    }
  }

  return Array.from(edgeById.values());
}

function collectIndexesForColumn(
  schemaGraph: SchemaGraph,
  snapshotBefore: SchemaSnapshot,
  tableId: string,
  schemaName: string,
  tableName: string,
  columnName: string
): SchemaSnapshotIndex[] {
  const normalizedColumn = normalizeIdentifier(columnName);
  const tableIndexes = collectIndexesForTable(schemaGraph, snapshotBefore, tableId, schemaName, tableName);
  return tableIndexes.filter((index) =>
    index.columns.some((column) => normalizeIdentifier(column) === normalizedColumn)
  );
}

function collectIndexesForTable(
  schemaGraph: SchemaGraph,
  snapshotBefore: SchemaSnapshot,
  tableId: string,
  schemaName?: string,
  tableName?: string
): SchemaSnapshotIndex[] {
  const node = schemaGraph.tables[tableId];
  if (node) {
    return node.indexes.map((index) => ({
      name: index.name,
      columns: [...index.columns],
      unique: index.unique,
      primary: index.primary,
      method: index.method,
      predicate: index.predicate,
    }));
  }

  if (!schemaName || !tableName) {
    return [];
  }

  for (const schema of snapshotBefore.schemas) {
    if (!identifiersEqual(schema.name, schemaName)) {
      continue;
    }
    for (const table of schema.tables) {
      if (!identifiersEqual(table.name, tableName)) {
        continue;
      }
      return table.indexes.map((index) => ({
        name: index.name,
        columns: [...index.columns],
        unique: index.unique,
        primary: index.primary,
        method: index.method,
        predicate: index.predicate,
      }));
    }
  }

  return [];
}

function parseQualifiedTableName(value: string): { schemaName: string; tableName: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }
  return {
    schemaName: trimmed.slice(0, separatorIndex),
    tableName: trimmed.slice(separatorIndex + 1),
  };
}

function containsTableReference(definition: string, schemaName: string, tableName: string): boolean {
  const escapedSchema = escapeRegExp(schemaName);
  const escapedTable = escapeRegExp(tableName);

  const qualifiedQuotedPattern = new RegExp(
    `"${escapeRegExp(schemaName)}"\\s*\\.\\s*"${escapeRegExp(tableName)}"`,
    "i"
  );
  const qualifiedUnquotedPattern = new RegExp(`\\b${escapedSchema}\\s*\\.\\s*${escapedTable}\\b`, "i");
  const unqualifiedPattern = new RegExp(
    `\\b(from|join|update|into|table|on|references)\\s+(only\\s+)?(?:"${escapeRegExp(
      schemaName
    )}"\\s*\\.\\s*)?(?:"${escapeRegExp(tableName)}"|${escapedTable})\\b`,
    "i"
  );

  return (
    qualifiedQuotedPattern.test(definition) ||
    qualifiedUnquotedPattern.test(definition) ||
    unqualifiedPattern.test(definition)
  );
}

function containsQualifiedColumnReference(
  definition: string,
  schemaName: string,
  tableName: string,
  columnName: string
): boolean {
  const escapedSchema = escapeRegExp(schemaName);
  const escapedTable = escapeRegExp(tableName);
  const escapedColumn = escapeRegExp(columnName);

  const quotedPattern = new RegExp(
    `(?:"${escapeRegExp(schemaName)}"\\s*\\.\\s*)?"${escapeRegExp(tableName)}"\\s*\\.\\s*"${escapeRegExp(
      columnName
    )}"`,
    "i"
  );
  const unquotedPattern = new RegExp(
    `\\b(?:${escapedSchema}\\s*\\.\\s*)?${escapedTable}\\s*\\.\\s*${escapedColumn}\\b`,
    "i"
  );
  return quotedPattern.test(definition) || unquotedPattern.test(definition);
}

function containsIdentifier(value: string, identifier: string): boolean {
  const escapedIdentifier = escapeRegExp(identifier);
  const identifierPattern = new RegExp(`(^|[^A-Za-z0-9_])${escapedIdentifier}([^A-Za-z0-9_]|$)`, "i");
  if (identifierPattern.test(value)) {
    return true;
  }
  const quotedIdentifier = `"${identifier.replace(/"/g, '""')}"`;
  return value.toLowerCase().includes(quotedIdentifier.toLowerCase());
}

function hasColumnTypeChanged(change: MigrationDiffColumnChange): boolean {
  if (!change.previous || !change.next) {
    return false;
  }
  return normalizeDataType(change.previous.dataType) !== normalizeDataType(change.next.dataType);
}

function normalizeDataType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function identifiersEqual(left: string, right: string): boolean {
  return normalizeIdentifier(left) === normalizeIdentifier(right);
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function formatTableImpact(schemaName: string, tableName: string): string {
  return `table ${schemaName}.${tableName}`;
}

function formatIndexImpact(schemaName: string, tableName: string, indexName: string): string {
  return `index ${schemaName}.${tableName}.${indexName}`;
}

function formatForeignKeyImpact(edge: SchemaGraphForeignKeyEdge): string {
  return `foreign_key ${edge.source.schemaName}.${edge.source.tableName}.${edge.name} -> ${edge.target.schemaName}.${edge.target.tableName}`;
}

function sortValues(values: Set<string>): string[] {
  return Array.from(values.values()).sort((left, right) => left.localeCompare(right));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
