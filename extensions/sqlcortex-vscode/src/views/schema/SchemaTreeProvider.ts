import * as vscode from "vscode";
import type { ApiSessionManager } from "../../core/auth/ApiSessionManager";
import type { TargetStore } from "../../core/target/TargetStore";
import { getDbCopilotSchemaSnapshots, getDbCopilotState } from "../../state/dbCopilotState";
import {
  buildSchemaNode,
  createEmptySnapshotNode,
  createErrorNode,
  createLoadingNode,
  createLoginRequiredNode,
  createSelectTargetNode,
  type SchemaTreeColumn,
  type SchemaTreeConstraint,
  type SchemaTreeForeignKey,
  type SchemaTreeIndex,
  type SchemaTreeRoutine,
  type SchemaTreeSchema,
  type SchemaTreeTable,
  type SchemaTreeView,
  type SchemaTreeNode,
} from "./nodes";

type SchemaTreeProviderDeps = {
  context: vscode.ExtensionContext;
  sessionManager: ApiSessionManager;
  targetStore: TargetStore;
};

export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    SchemaTreeNode | undefined
  >();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly deps: SchemaTreeProviderDeps) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: SchemaTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SchemaTreeNode): Promise<SchemaTreeNode[]> {
    if (element) {
      return element.children;
    }

    const token = await this.deps.sessionManager.getToken();
    if (!token) {
      return [createLoginRequiredNode()];
    }

    const target = this.deps.targetStore.getSelectedTarget();
    if (!target) {
      return [createSelectTargetNode()];
    }

    const state = getDbCopilotState(this.deps.context);
    if (state.schemaSnapshotStatus === "loading") {
      return [createLoadingNode()];
    }
    if (state.schemaSnapshotStatus === "error") {
      return [
        createErrorNode({
          message: state.schemaSnapshotError,
          code: state.schemaSnapshotErrorCode,
        }),
      ];
    }

    const schemas = normalizeSchemaNodes(getDbCopilotSchemaSnapshots(this.deps.context));
    if (schemas.length === 0) {
      return [createEmptySnapshotNode()];
    }

    return schemas
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((schema) => buildSchemaNode(schema));
  }
}

function normalizeSchemaNodes(rawSnapshot: unknown): SchemaTreeSchema[] {
  const fromEnvelope = parseSnapshotEnvelope(rawSnapshot);
  if (fromEnvelope) {
    return fromEnvelope;
  }
  return parseSnapshotMap(rawSnapshot);
}

function parseSnapshotEnvelope(rawSnapshot: unknown): SchemaTreeSchema[] | null {
  const payload = asRecord(rawSnapshot);
  if (!payload) {
    return null;
  }
  const schemas = asArray(payload.schemas);
  if (!schemas) {
    return null;
  }
  return schemas
    .map((schema) => parseSchemaRecord(schema, null))
    .filter((schema): schema is SchemaTreeSchema => Boolean(schema));
}

function parseSnapshotMap(rawSnapshot: unknown): SchemaTreeSchema[] {
  const payload = asRecord(rawSnapshot);
  if (!payload) {
    return [];
  }

  return Object.entries(payload)
    .map(([fallbackName, entry]) => parseSchemaRecord(entry, fallbackName))
    .filter((schema): schema is SchemaTreeSchema => Boolean(schema));
}

function parseSchemaRecord(
  value: unknown,
  fallbackName: string | null
): SchemaTreeSchema | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const schemaName = nonEmptyString(record.name) ?? nonEmptyString(record.schema) ?? fallbackName;
  if (!schemaName) {
    return null;
  }

  const tables = (asArray(record.tables) ?? [])
    .map((table) => parseTableRecord(table))
    .filter((table): table is SchemaTreeTable => Boolean(table));
  const views = (asArray(record.views) ?? [])
    .map((view) => parseViewRecord(view))
    .filter((view): view is SchemaTreeView => Boolean(view));

  const routines = (asArray(record.routines) ?? [])
    .map((routine) => parseRoutineRecord(routine))
    .filter((routine): routine is SchemaTreeRoutine => Boolean(routine));
  const functions = (asArray(record.functions) ?? [])
    .map((routine) => parseRoutineRecord(routine))
    .filter((routine): routine is SchemaTreeRoutine => Boolean(routine));
  const procedures = (asArray(record.procedures) ?? [])
    .map((routine) => parseRoutineRecord(routine))
    .filter((routine): routine is SchemaTreeRoutine => Boolean(routine));

  const resolvedFunctions = functions.length
    ? functions
    : routines.filter((routine) => {
        const kind = parseRoutineKind(routine, "function");
        return kind === "function";
      });
  const resolvedProcedures = procedures.length
    ? procedures
    : routines.filter((routine) => {
        const kind = parseRoutineKind(routine, "function");
        return kind === "procedure";
      });

  return {
    name: schemaName,
    tables,
    views,
    functions: resolvedFunctions,
    procedures: resolvedProcedures,
  };
}

function parseTableRecord(value: unknown): SchemaTreeTable | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const tableName = nonEmptyString(record.name);
  if (!tableName) {
    return null;
  }

  const columns = (asArray(record.columns) ?? [])
    .map((column) => parseColumnRecord(column))
    .filter((column): column is SchemaTreeColumn => Boolean(column));
  const constraints = (asArray(record.constraints) ?? [])
    .map((constraint) => parseConstraintRecord(constraint))
    .filter((constraint): constraint is SchemaTreeConstraint => Boolean(constraint));
  const foreignKeys = (asArray(record.foreignKeys) ?? [])
    .map((foreignKey, index) => parseForeignKeyRecord(foreignKey, index))
    .filter((foreignKey): foreignKey is SchemaTreeForeignKey => Boolean(foreignKey));
  const indexes = (asArray(record.indexes) ?? [])
    .map((index) => parseIndexRecord(index))
    .filter((index): index is SchemaTreeIndex => Boolean(index));

  // Legacy snapshots expose `primaryKey` separately; map it into constraints.
  const primaryKeyColumns = toStringArray(record.primaryKey);
  if (primaryKeyColumns.length > 0 && constraints.every((item) => item.type !== "PRIMARY KEY")) {
    constraints.unshift({
      name: `${tableName}_pkey`,
      type: "PRIMARY KEY",
      columns: primaryKeyColumns,
      definition: null,
    });
  }

  return {
    name: tableName,
    columns,
    constraints,
    foreignKeys,
    indexes,
  };
}

function parseColumnRecord(value: unknown): SchemaTreeColumn | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = nonEmptyString(record.name);
  const dataType = nonEmptyString(record.dataType) ?? nonEmptyString(record.type);
  if (!name || !dataType) {
    return null;
  }
  return {
    name,
    dataType,
    nullable: asBoolean(record.nullable, false),
    defaultValue: nonEmptyString(record.default) ?? null,
  };
}

function parseConstraintRecord(value: unknown): SchemaTreeConstraint | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = nonEmptyString(record.name);
  const type = nonEmptyString(record.type);
  if (!name || !type) {
    return null;
  }
  return {
    name,
    type,
    columns: toStringArray(record.columns),
    definition: nonEmptyString(record.definition) ?? null,
  };
}

function parseForeignKeyRecord(value: unknown, fallbackIndex: number): SchemaTreeForeignKey | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const refs = asRecord(record.references);

  const name = nonEmptyString(record.name) ?? `fk_${fallbackIndex + 1}`;
  const referencedSchema =
    nonEmptyString(record.referencedSchema) ??
    nonEmptyString(record.foreignSchema) ??
    nonEmptyString(refs?.schema);
  const referencedTable =
    nonEmptyString(record.referencedTable) ??
    nonEmptyString(record.foreignTable) ??
    nonEmptyString(refs?.table);
  if (!referencedSchema || !referencedTable) {
    return null;
  }

  return {
    name,
    columns: toStringArray(record.columns),
    referencedSchema,
    referencedTable,
    referencedColumns: toStringArray(record.referencedColumns ?? record.foreignColumns ?? refs?.columns),
    onUpdate: nonEmptyString(record.onUpdate) ?? null,
    onDelete: nonEmptyString(record.onDelete) ?? null,
  };
}

function parseIndexRecord(value: unknown): SchemaTreeIndex | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = nonEmptyString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    columns: toStringArray(record.columns),
    unique: asBoolean(record.unique, false),
    primary: asBoolean(record.primary, false),
    method: nonEmptyString(record.method) ?? null,
    predicate: nonEmptyString(record.predicate) ?? null,
  };
}

function parseViewRecord(value: unknown): SchemaTreeView | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = nonEmptyString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    definition: nonEmptyString(record.definition) ?? null,
  };
}

function parseRoutineRecord(value: unknown): SchemaTreeRoutine | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = nonEmptyString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    kind: nonEmptyString(record.kind) ?? nonEmptyString(record.type) ?? null,
    signature: nonEmptyString(record.signature) ?? null,
    returnType: nonEmptyString(record.returnType) ?? null,
    language: nonEmptyString(record.language) ?? null,
  };
}

function parseRoutineKind(
  routine: SchemaTreeRoutine,
  fallback: "function" | "procedure"
): "function" | "procedure" {
  const kind = typeof routine.kind === "string" ? routine.kind.toLowerCase() : fallback;
  return kind === "procedure" ? "procedure" : "function";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "no" || normalized === "0") {
      return false;
    }
  }
  return fallback;
}
