import { diffSnapshots, type SchemaDiffKind, type SchemaSnapshotDiff } from "../schema/diff";
import type {
  SchemaSnapshot,
  SchemaSnapshotColumn,
  SchemaSnapshotConstraint,
  SchemaSnapshotForeignKey,
  SchemaSnapshotIndex,
  SchemaSnapshotSchema,
  SchemaSnapshotTable,
} from "../schema/SchemaTypes";

export type MigrationDiffColumnChange = {
  schemaName: string;
  tableName: string;
  columnName: string;
  previous: SchemaSnapshotColumn | null;
  next: SchemaSnapshotColumn | null;
};

export type MigrationDiffIndexChange = {
  schemaName: string;
  tableName: string;
  indexName: string;
  previous: SchemaSnapshotIndex | null;
  next: SchemaSnapshotIndex | null;
};

export type MigrationDiffConstraintChange = {
  kind: SchemaDiffKind;
  schemaName: string;
  tableName: string;
  constraintName: string;
  source: "constraint" | "foreignKey";
  previous: SchemaSnapshotConstraint | SchemaSnapshotForeignKey | null;
  next: SchemaSnapshotConstraint | SchemaSnapshotForeignKey | null;
};

export type MigrationDiff = {
  tablesAdded: string[];
  tablesRemoved: string[];
  columnsAdded: MigrationDiffColumnChange[];
  columnsRemoved: MigrationDiffColumnChange[];
  columnsAltered: MigrationDiffColumnChange[];
  indexesAdded: MigrationDiffIndexChange[];
  indexesRemoved: MigrationDiffIndexChange[];
  constraintsChanged: MigrationDiffConstraintChange[];
};

export type MigrationDiffBuildResult = {
  statements: string[];
  appliedStatements: number;
  snapshotBefore: SchemaSnapshot;
  simulatedSnapshotAfter: SchemaSnapshot;
  snapshotDiff: SchemaSnapshotDiff;
  migrationDiff: MigrationDiff;
};

type TableRef = {
  schemaName: string;
  tableName: string;
};

type AlterTableContext = {
  schema: SchemaSnapshotSchema;
  table: SchemaSnapshotTable;
  ref: TableRef;
};

type ParsedConstraint = {
  constraint: SchemaSnapshotConstraint;
  foreignKey: SchemaSnapshotForeignKey | null;
};

const DEFAULT_SCHEMA_NAME = "public";

export function buildMigrationDiff(options: {
  snapshotBefore: SchemaSnapshot;
  ddlSql: string;
  defaultSchema?: string;
}): MigrationDiffBuildResult {
  const snapshotBefore = cloneSnapshot(options.snapshotBefore);
  const simulatedSnapshotAfter = cloneSnapshot(options.snapshotBefore);
  const defaultSchema = normalizeIdentifier(options.defaultSchema ?? DEFAULT_SCHEMA_NAME);
  const statements = splitSqlStatements(options.ddlSql);

  let appliedStatements = 0;
  for (const statement of statements) {
    try {
      if (applyDdlStatement(simulatedSnapshotAfter, statement, defaultSchema)) {
        appliedStatements += 1;
      }
    } catch {
      // Keep simulation best-effort; unsupported or malformed statements become no-op.
    }
  }

  const snapshotDiff = diffSnapshots(snapshotBefore, simulatedSnapshotAfter);
  const migrationDiff = buildStructuredMigrationDiff(snapshotDiff);

  return {
    statements,
    appliedStatements,
    snapshotBefore,
    simulatedSnapshotAfter,
    snapshotDiff,
    migrationDiff,
  };
}

function buildStructuredMigrationDiff(snapshotDiff: SchemaSnapshotDiff): MigrationDiff {
  const tablesAdded = snapshotDiff.tableChanges
    .filter((change) => change.kind === "added")
    .map((change) => formatTableName(change.schemaName, change.tableName))
    .sort((left, right) => left.localeCompare(right));
  const tablesRemoved = snapshotDiff.tableChanges
    .filter((change) => change.kind === "removed")
    .map((change) => formatTableName(change.schemaName, change.tableName))
    .sort((left, right) => left.localeCompare(right));

  const columnsAdded = snapshotDiff.columnChanges
    .filter((change) => change.kind === "added")
    .map((change) => ({
      schemaName: change.schemaName,
      tableName: change.tableName,
      columnName: change.columnName,
      previous: null,
      next: change.next,
    }))
    .sort(compareColumnChanges);
  const columnsRemoved = snapshotDiff.columnChanges
    .filter((change) => change.kind === "removed")
    .map((change) => ({
      schemaName: change.schemaName,
      tableName: change.tableName,
      columnName: change.columnName,
      previous: change.previous,
      next: null,
    }))
    .sort(compareColumnChanges);
  const columnsAltered = snapshotDiff.columnChanges
    .filter((change) => change.kind === "changed")
    .map((change) => ({
      schemaName: change.schemaName,
      tableName: change.tableName,
      columnName: change.columnName,
      previous: change.previous,
      next: change.next,
    }))
    .sort(compareColumnChanges);

  const indexesAdded: MigrationDiffIndexChange[] = [];
  const indexesRemoved: MigrationDiffIndexChange[] = [];
  for (const change of snapshotDiff.indexChanges) {
    if (change.kind === "added") {
      indexesAdded.push({
        schemaName: change.schemaName,
        tableName: change.tableName,
        indexName: change.indexName,
        previous: null,
        next: change.next,
      });
      continue;
    }
    if (change.kind === "removed") {
      indexesRemoved.push({
        schemaName: change.schemaName,
        tableName: change.tableName,
        indexName: change.indexName,
        previous: change.previous,
        next: null,
      });
      continue;
    }
    indexesRemoved.push({
      schemaName: change.schemaName,
      tableName: change.tableName,
      indexName: change.indexName,
      previous: change.previous,
      next: null,
    });
    indexesAdded.push({
      schemaName: change.schemaName,
      tableName: change.tableName,
      indexName: change.indexName,
      previous: null,
      next: change.next,
    });
  }
  indexesAdded.sort(compareIndexChanges);
  indexesRemoved.sort(compareIndexChanges);

  const constraintsChanged: MigrationDiffConstraintChange[] = [];
  const seenConstraintChanges = new Set<string>();
  for (const tableChange of snapshotDiff.tableChanges) {
    if (tableChange.kind === "added" && tableChange.next) {
      for (const constraint of tableChange.next.constraints) {
        pushConstraintChange(
          constraintsChanged,
          seenConstraintChanges,
          {
            kind: "added",
            schemaName: tableChange.schemaName,
            tableName: tableChange.tableName,
            constraintName: constraint.name,
            source: "constraint",
            previous: null,
            next: constraint,
          }
        );
      }
      continue;
    }

    if (tableChange.kind === "removed" && tableChange.previous) {
      for (const constraint of tableChange.previous.constraints) {
        pushConstraintChange(
          constraintsChanged,
          seenConstraintChanges,
          {
            kind: "removed",
            schemaName: tableChange.schemaName,
            tableName: tableChange.tableName,
            constraintName: constraint.name,
            source: "constraint",
            previous: constraint,
            next: null,
          }
        );
      }
      continue;
    }

    if (tableChange.kind === "changed" && tableChange.previous && tableChange.next) {
      pushConstraintSetDiff(
        constraintsChanged,
        seenConstraintChanges,
        tableChange.schemaName,
        tableChange.tableName,
        tableChange.previous.constraints,
        tableChange.next.constraints
      );
    }
  }

  for (const foreignKeyChange of snapshotDiff.foreignKeyChanges) {
    pushConstraintChange(
      constraintsChanged,
      seenConstraintChanges,
      {
        kind: foreignKeyChange.kind,
        schemaName: foreignKeyChange.schemaName,
        tableName: foreignKeyChange.tableName,
        constraintName: foreignKeyChange.foreignKeyName,
        source: "foreignKey",
        previous: foreignKeyChange.previous,
        next: foreignKeyChange.next,
      }
    );
  }

  constraintsChanged.sort(compareConstraintChanges);

  return {
    tablesAdded,
    tablesRemoved,
    columnsAdded,
    columnsRemoved,
    columnsAltered,
    indexesAdded,
    indexesRemoved,
    constraintsChanged,
  };
}

function pushConstraintSetDiff(
  target: MigrationDiffConstraintChange[],
  seen: Set<string>,
  schemaName: string,
  tableName: string,
  previous: SchemaSnapshotConstraint[],
  next: SchemaSnapshotConstraint[]
): void {
  const previousByName = collectByName(previous);
  const nextByName = collectByName(next);
  const names = collectUnionKeys(previousByName, nextByName);
  for (const name of names) {
    const previousConstraint = previousByName.get(name) ?? null;
    const nextConstraint = nextByName.get(name) ?? null;
    if (!previousConstraint && nextConstraint) {
      pushConstraintChange(target, seen, {
        kind: "added",
        schemaName,
        tableName,
        constraintName: nextConstraint.name,
        source: "constraint",
        previous: null,
        next: nextConstraint,
      });
      continue;
    }
    if (previousConstraint && !nextConstraint) {
      pushConstraintChange(target, seen, {
        kind: "removed",
        schemaName,
        tableName,
        constraintName: previousConstraint.name,
        source: "constraint",
        previous: previousConstraint,
        next: null,
      });
      continue;
    }
    if (!previousConstraint || !nextConstraint) {
      continue;
    }
    if (serializeConstraint(previousConstraint) !== serializeConstraint(nextConstraint)) {
      pushConstraintChange(target, seen, {
        kind: "changed",
        schemaName,
        tableName,
        constraintName: nextConstraint.name,
        source: "constraint",
        previous: previousConstraint,
        next: nextConstraint,
      });
    }
  }
}

function pushConstraintChange(
  target: MigrationDiffConstraintChange[],
  seen: Set<string>,
  change: MigrationDiffConstraintChange
): void {
  const key = [
    change.source,
    change.kind,
    change.schemaName,
    change.tableName,
    change.constraintName,
  ].join("::");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  target.push(change);
}

function serializeConstraint(constraint: SchemaSnapshotConstraint): string {
  return [
    normalizeWhitespace(constraint.name),
    normalizeWhitespace(constraint.type),
    normalizeWhitespace(constraint.definition ?? ""),
    constraint.columns.join("|"),
  ].join("::");
}

function applyDdlStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const normalized = normalizeWhitespace(statement).toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("CREATE TABLE")) {
    return applyCreateTableStatement(snapshot, statement, defaultSchema);
  }
  if (normalized.startsWith("ALTER TABLE")) {
    return applyAlterTableStatement(snapshot, statement, defaultSchema);
  }
  if (normalized.startsWith("DROP TABLE")) {
    return applyDropTableStatement(snapshot, statement, defaultSchema);
  }
  if (normalized.startsWith("CREATE INDEX") || normalized.startsWith("CREATE UNIQUE INDEX")) {
    return applyCreateIndexStatement(snapshot, statement, defaultSchema);
  }
  if (normalized.startsWith("DROP INDEX")) {
    return applyDropIndexStatement(snapshot, statement, defaultSchema);
  }
  return false;
}

function applyCreateTableStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const prefixMatch = statement.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }

  const isIfNotExists = /\bIF\s+NOT\s+EXISTS\b/i.test(prefixMatch[0]);
  const parsedTableName = readQualifiedIdentifier(statement, prefixMatch[0].length);
  if (!parsedTableName) {
    return false;
  }
  const tableRef = toTableRef(parsedTableName.parts, defaultSchema);

  const openParenIndex = indexOfNextNonWhitespace(statement, parsedTableName.nextIndex);
  if (openParenIndex < 0 || statement[openParenIndex] !== "(") {
    return false;
  }
  const parenthesized = readParenthesizedBlock(statement, openParenIndex);
  if (!parenthesized) {
    return false;
  }

  if (findTable(snapshot, tableRef)) {
    return isIfNotExists;
  }

  const definitions = splitTopLevel(parenthesized.content, ",");
  const columns: SchemaSnapshotColumn[] = [];
  const constraints: SchemaSnapshotConstraint[] = [];
  const foreignKeys: SchemaSnapshotForeignKey[] = [];

  for (const definition of definitions) {
    const entry = definition.trim();
    if (!entry) {
      continue;
    }
    if (isTableConstraintDefinition(entry)) {
      const parsedConstraint = parseTableConstraintDefinition(
        entry,
        defaultSchema,
        tableRef,
        constraints.length + 1
      );
      if (parsedConstraint) {
        constraints.push(parsedConstraint.constraint);
        if (parsedConstraint.foreignKey) {
          foreignKeys.push(parsedConstraint.foreignKey);
        }
      }
      continue;
    }
    const parsedColumn = parseColumnDefinition(entry);
    if (parsedColumn) {
      columns.push(parsedColumn);
    }
  }

  const schema = ensureSchema(snapshot, tableRef.schemaName);
  schema.tables.push({
    name: tableRef.tableName,
    columns,
    constraints,
    foreignKeys,
    indexes: [],
  });
  return true;
}

function applyDropTableStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const prefixMatch = statement.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }

  const remainder = statement.slice(prefixMatch[0].length).trim();
  if (!remainder) {
    return false;
  }

  const tableSpecs = splitTopLevel(remainder, ",");
  let changed = false;
  for (const tableSpec of tableSpecs) {
    const cleaned = trimDropQualifier(tableSpec);
    const parsed = parseQualifiedIdentifier(cleaned);
    if (!parsed) {
      continue;
    }
    const tableRef = toTableRef(parsed, defaultSchema);
    changed = removeTable(snapshot, tableRef) || changed;
  }
  return changed;
}

function applyAlterTableStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const prefixMatch = statement.match(/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }
  const parsedTableName = readQualifiedIdentifier(statement, prefixMatch[0].length);
  if (!parsedTableName) {
    return false;
  }
  const tableRef = toTableRef(parsedTableName.parts, defaultSchema);
  const isIfExists = /\bIF\s+EXISTS\b/i.test(prefixMatch[0]);
  const located = findTableEntry(snapshot, tableRef);
  if (!located) {
    return isIfExists;
  }

  const actionsSql = statement.slice(parsedTableName.nextIndex).trim();
  if (!actionsSql) {
    return false;
  }

  const actions = splitTopLevel(actionsSql, ",");
  let changed = false;
  let context: AlterTableContext = {
    schema: located.schema,
    table: located.table,
    ref: tableRef,
  };
  for (const action of actions) {
    const actionResult = applyAlterTableAction(snapshot, context, action, defaultSchema);
    if (actionResult.changed) {
      changed = true;
    }
    context = actionResult.context;
  }

  return changed;
}

function applyAlterTableAction(
  snapshot: SchemaSnapshot,
  context: AlterTableContext,
  rawAction: string,
  defaultSchema: string
): {
  changed: boolean;
  context: AlterTableContext;
} {
  const action = rawAction.trim();
  if (!action) {
    return { changed: false, context };
  }
  const normalized = normalizeWhitespace(action).toUpperCase();

  if (normalized.startsWith("ADD COLUMN") || normalized.startsWith("ADD ")) {
    if (
      normalized.startsWith("ADD CONSTRAINT") ||
      normalized.startsWith("ADD PRIMARY KEY") ||
      normalized.startsWith("ADD UNIQUE") ||
      normalized.startsWith("ADD FOREIGN KEY") ||
      normalized.startsWith("ADD CHECK")
    ) {
      const changed = applyAlterAddConstraint(context.table, context.ref, action, defaultSchema);
      return { changed, context };
    }
    const changed = applyAlterAddColumn(context.table, action);
    return { changed, context };
  }

  if (normalized.startsWith("DROP COLUMN")) {
    const changed = applyAlterDropColumn(context.table, action);
    return { changed, context };
  }

  if (normalized.startsWith("ALTER COLUMN")) {
    const changed = applyAlterModifyColumn(context.table, action);
    return { changed, context };
  }

  if (normalized.startsWith("RENAME COLUMN")) {
    const changed = applyAlterRenameColumn(context.table, action);
    return { changed, context };
  }

  if (normalized.startsWith("DROP CONSTRAINT")) {
    const changed = applyAlterDropConstraint(context.table, action);
    return { changed, context };
  }

  if (normalized.startsWith("RENAME TO")) {
    const renamed = applyAlterRenameTable(snapshot, context, action);
    return renamed;
  }

  return { changed: false, context };
}

function applyAlterAddColumn(table: SchemaSnapshotTable, action: string): boolean {
  const prefixMatch = action.match(/^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }
  const isIfNotExists = /\bIF\s+NOT\s+EXISTS\b/i.test(prefixMatch[0]);
  const columnNameToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!columnNameToken) {
    return false;
  }
  const columnName = normalizeIdentifier(columnNameToken.token);
  const existing = table.columns.find((column) => column.name === columnName);
  if (existing) {
    return isIfNotExists;
  }

  const definitionTail = action.slice(columnNameToken.nextIndex).trim();
  if (!definitionTail) {
    return false;
  }

  const parsedAttributes = parseColumnAttributes(definitionTail);
  table.columns.push({
    name: columnName,
    dataType: parsedAttributes.dataType || "text",
    nullable: parsedAttributes.nullable,
    default: parsedAttributes.defaultValue,
  });
  return true;
}

function applyAlterDropColumn(table: SchemaSnapshotTable, action: string): boolean {
  const prefixMatch = action.match(/^\s*DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }
  const columnToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!columnToken) {
    return false;
  }
  const columnName = normalizeIdentifier(columnToken.token);
  const beforeCount = table.columns.length;
  table.columns = table.columns.filter((column) => column.name !== columnName);
  if (table.columns.length === beforeCount) {
    return false;
  }

  for (const index of table.indexes) {
    index.columns = index.columns.filter((column) => column !== columnName);
  }
  table.indexes = table.indexes.filter((index) => index.columns.length > 0);

  for (const constraint of table.constraints) {
    constraint.columns = constraint.columns.filter((column) => column !== columnName);
  }
  table.constraints = table.constraints.filter(
    (constraint) => constraint.type === "CHECK" || constraint.columns.length > 0
  );

  for (const foreignKey of table.foreignKeys) {
    const retainedIndexes: number[] = [];
    for (let index = 0; index < foreignKey.columns.length; index += 1) {
      if (foreignKey.columns[index] !== columnName) {
        retainedIndexes.push(index);
      }
    }
    foreignKey.columns = retainedIndexes.map((index) => foreignKey.columns[index]);
    foreignKey.referencedColumns = retainedIndexes.map((index) => foreignKey.referencedColumns[index]);
  }
  table.foreignKeys = table.foreignKeys.filter((foreignKey) => foreignKey.columns.length > 0);
  return true;
}

function applyAlterModifyColumn(table: SchemaSnapshotTable, action: string): boolean {
  const prefixMatch = action.match(/^\s*ALTER\s+COLUMN\s+/i);
  if (!prefixMatch) {
    return false;
  }
  const columnToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!columnToken) {
    return false;
  }
  const columnName = normalizeIdentifier(columnToken.token);
  const column = table.columns.find((entry) => entry.name === columnName);
  if (!column) {
    return false;
  }

  const operation = action.slice(columnToken.nextIndex).trim();
  if (!operation) {
    return false;
  }

  if (/^TYPE\s+/i.test(operation)) {
    const newType = operation.replace(/^TYPE\s+/i, "").replace(/\s+USING[\s\S]*$/i, "").trim();
    if (!newType || column.dataType === newType) {
      return false;
    }
    column.dataType = newType;
    return true;
  }

  if (/^SET\s+NOT\s+NULL$/i.test(operation)) {
    if (!column.nullable) {
      return false;
    }
    column.nullable = false;
    return true;
  }

  if (/^DROP\s+NOT\s+NULL$/i.test(operation)) {
    if (column.nullable) {
      return false;
    }
    column.nullable = true;
    return true;
  }

  if (/^SET\s+DEFAULT\s+/i.test(operation)) {
    const defaultValue = operation.replace(/^SET\s+DEFAULT\s+/i, "").trim();
    if (!defaultValue) {
      return false;
    }
    if (normalizeWhitespace(column.default ?? "") === normalizeWhitespace(defaultValue)) {
      return false;
    }
    column.default = defaultValue;
    return true;
  }

  if (/^DROP\s+DEFAULT$/i.test(operation)) {
    if (column.default === null) {
      return false;
    }
    column.default = null;
    return true;
  }

  return false;
}

function applyAlterRenameColumn(table: SchemaSnapshotTable, action: string): boolean {
  const prefixMatch = action.match(/^\s*RENAME\s+COLUMN\s+/i);
  if (!prefixMatch) {
    return false;
  }
  const sourceToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!sourceToken) {
    return false;
  }
  const sourceColumnName = normalizeIdentifier(sourceToken.token);

  const toMatch = action.slice(sourceToken.nextIndex).match(/^\s*TO\s+/i);
  if (!toMatch) {
    return false;
  }
  const targetToken = readIdentifierToken(
    action,
    sourceToken.nextIndex + toMatch[0].length
  );
  if (!targetToken) {
    return false;
  }
  const targetColumnName = normalizeIdentifier(targetToken.token);
  if (sourceColumnName === targetColumnName) {
    return false;
  }

  const column = table.columns.find((entry) => entry.name === sourceColumnName);
  if (!column) {
    return false;
  }
  column.name = targetColumnName;

  for (const index of table.indexes) {
    index.columns = index.columns.map((name) =>
      name === sourceColumnName ? targetColumnName : name
    );
  }
  for (const constraint of table.constraints) {
    constraint.columns = constraint.columns.map((name) =>
      name === sourceColumnName ? targetColumnName : name
    );
  }
  for (const foreignKey of table.foreignKeys) {
    foreignKey.columns = foreignKey.columns.map((name) =>
      name === sourceColumnName ? targetColumnName : name
    );
  }

  return true;
}

function applyAlterAddConstraint(
  table: SchemaSnapshotTable,
  tableRef: TableRef,
  action: string,
  defaultSchema: string
): boolean {
  const prefixMatch = action.match(/^\s*ADD\s+/i);
  if (!prefixMatch) {
    return false;
  }
  const definition = action.slice(prefixMatch[0].length).trim();
  if (!definition) {
    return false;
  }
  const parsedConstraint = parseTableConstraintDefinition(
    definition,
    defaultSchema,
    tableRef,
    table.constraints.length + 1
  );
  if (!parsedConstraint) {
    return false;
  }

  if (table.constraints.some((constraint) => constraint.name === parsedConstraint.constraint.name)) {
    return false;
  }
  table.constraints.push(parsedConstraint.constraint);

  if (parsedConstraint.foreignKey) {
    if (
      table.foreignKeys.some(
        (foreignKey) => foreignKey.name === parsedConstraint.foreignKey?.name
      )
    ) {
      return true;
    }
    table.foreignKeys.push(parsedConstraint.foreignKey);
  }
  return true;
}

function applyAlterDropConstraint(table: SchemaSnapshotTable, action: string): boolean {
  const prefixMatch = action.match(/^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }
  const constraintToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!constraintToken) {
    return false;
  }
  const constraintName = normalizeIdentifier(constraintToken.token);

  const previousConstraintCount = table.constraints.length;
  const previousForeignKeyCount = table.foreignKeys.length;
  table.constraints = table.constraints.filter((constraint) => constraint.name !== constraintName);
  table.foreignKeys = table.foreignKeys.filter((foreignKey) => foreignKey.name !== constraintName);
  return (
    table.constraints.length !== previousConstraintCount ||
    table.foreignKeys.length !== previousForeignKeyCount
  );
}

function applyAlterRenameTable(
  snapshot: SchemaSnapshot,
  context: AlterTableContext,
  action: string
): {
  changed: boolean;
  context: AlterTableContext;
} {
  const prefixMatch = action.match(/^\s*RENAME\s+TO\s+/i);
  if (!prefixMatch) {
    return { changed: false, context };
  }
  const targetToken = readIdentifierToken(action, prefixMatch[0].length);
  if (!targetToken) {
    return { changed: false, context };
  }
  const nextTableName = normalizeIdentifier(targetToken.token);
  if (!nextTableName || context.table.name === nextTableName) {
    return { changed: false, context };
  }
  const oldRef = context.ref;
  context.table.name = nextTableName;
  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      for (const foreignKey of table.foreignKeys) {
        if (
          foreignKey.referencedSchema === oldRef.schemaName &&
          foreignKey.referencedTable === oldRef.tableName
        ) {
          foreignKey.referencedTable = nextTableName;
        }
      }
    }
  }
  const updatedRef: TableRef = {
    schemaName: oldRef.schemaName,
    tableName: nextTableName,
  };
  return {
    changed: true,
    context: {
      schema: context.schema,
      table: context.table,
      ref: updatedRef,
    },
  };
}

function applyCreateIndexStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const prefixMatch = statement.match(
    /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i
  );
  if (!prefixMatch) {
    return false;
  }

  const isUnique = /\bUNIQUE\b/i.test(prefixMatch[0]);
  const isIfNotExists = /\bIF\s+NOT\s+EXISTS\b/i.test(prefixMatch[0]);
  const parsedIndexName = readQualifiedIdentifier(statement, prefixMatch[0].length);
  if (!parsedIndexName) {
    return false;
  }
  const indexIdentity = toQualifiedName(parsedIndexName.parts, defaultSchema);
  const onKeywordMatch = matchKeyword(statement, parsedIndexName.nextIndex, "ON");
  if (!onKeywordMatch) {
    return false;
  }

  let cursor = onKeywordMatch.nextIndex;
  const onlyKeywordMatch = matchKeyword(statement, cursor, "ONLY");
  if (onlyKeywordMatch) {
    cursor = onlyKeywordMatch.nextIndex;
  }

  const parsedTableName = readQualifiedIdentifier(statement, cursor);
  if (!parsedTableName) {
    return false;
  }
  const tableRef = toTableRef(parsedTableName.parts, defaultSchema);
  const table = findTable(snapshot, tableRef);
  if (!table) {
    return false;
  }

  cursor = parsedTableName.nextIndex;
  let method: string | null = null;
  const usingKeywordMatch = matchKeyword(statement, cursor, "USING");
  if (usingKeywordMatch) {
    const methodToken = readIdentifierToken(statement, usingKeywordMatch.nextIndex);
    if (methodToken) {
      method = normalizeIdentifier(methodToken.token);
      cursor = methodToken.nextIndex;
    } else {
      cursor = usingKeywordMatch.nextIndex;
    }
  }

  const openParenIndex = indexOfNextNonWhitespace(statement, cursor);
  if (openParenIndex < 0 || statement[openParenIndex] !== "(") {
    return false;
  }
  const parenthesized = readParenthesizedBlock(statement, openParenIndex);
  if (!parenthesized) {
    return false;
  }

  const rawColumns = splitTopLevel(parenthesized.content, ",");
  const columns = rawColumns.map(parseIndexedColumn).filter((entry) => entry.length > 0);
  const remainder = statement.slice(parenthesized.nextIndex).trim();
  const predicateMatch = remainder.match(/^WHERE\s+([\s\S]+)$/i);
  const predicate = predicateMatch ? predicateMatch[1].trim() : null;

  const existingIndex = table.indexes.find((index) => index.name === indexIdentity.name);
  if (existingIndex) {
    if (isIfNotExists) {
      return true;
    }
    table.indexes = table.indexes.filter((index) => index.name !== indexIdentity.name);
  }

  table.indexes.push({
    name: indexIdentity.name,
    columns,
    unique: isUnique,
    primary: false,
    method,
    predicate,
  });
  return true;
}

function applyDropIndexStatement(
  snapshot: SchemaSnapshot,
  statement: string,
  defaultSchema: string
): boolean {
  const prefixMatch = statement.match(/^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return false;
  }

  const remainder = statement.slice(prefixMatch[0].length).trim();
  if (!remainder) {
    return false;
  }

  const targets = splitTopLevel(remainder, ",");
  let changed = false;
  for (const target of targets) {
    const cleaned = trimDropQualifier(target);
    const parsed = parseQualifiedIdentifier(cleaned);
    if (!parsed) {
      continue;
    }
    const indexIdentity = toQualifiedName(parsed, defaultSchema);
    changed = removeIndex(snapshot, indexIdentity.schemaName, indexIdentity.name) || changed;
  }
  return changed;
}

function removeIndex(snapshot: SchemaSnapshot, schemaName: string, indexName: string): boolean {
  let changed = false;
  for (const schema of snapshot.schemas) {
    if (schemaName !== "*" && schema.name !== schemaName) {
      continue;
    }
    for (const table of schema.tables) {
      const beforeCount = table.indexes.length;
      table.indexes = table.indexes.filter((index) => index.name !== indexName);
      if (table.indexes.length !== beforeCount) {
        changed = true;
      }
    }
  }
  return changed;
}

function parseColumnDefinition(definition: string): SchemaSnapshotColumn | null {
  const token = readIdentifierToken(definition, 0);
  if (!token) {
    return null;
  }
  const columnName = normalizeIdentifier(token.token);
  const attributes = parseColumnAttributes(definition.slice(token.nextIndex).trim());
  return {
    name: columnName,
    dataType: attributes.dataType || "text",
    nullable: attributes.nullable,
    default: attributes.defaultValue,
  };
}

function parseColumnAttributes(definitionTail: string): {
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
} {
  const nullable = /\bNOT\s+NULL\b/i.test(definitionTail)
    ? false
    : true;
  const defaultMatch = definitionTail.match(
    /\bDEFAULT\s+([\s\S]+?)(?=\s+(?:CONSTRAINT|NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES)\b|$)/i
  );
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;

  let dataType = definitionTail;
  if (defaultMatch) {
    dataType = dataType.replace(defaultMatch[0], " ");
  }
  dataType = dataType
    .replace(/\bNOT\s+NULL\b/gi, " ")
    .replace(/\bNULL\b/gi, " ")
    .replace(/\bCONSTRAINT\b[\s\S]*$/i, " ")
    .replace(/\bPRIMARY\s+KEY\b[\s\S]*$/i, " ")
    .replace(/\bUNIQUE\b[\s\S]*$/i, " ")
    .replace(/\bCHECK\b[\s\S]*$/i, " ")
    .replace(/\bREFERENCES\b[\s\S]*$/i, " ")
    .trim();

  return {
    dataType,
    nullable,
    defaultValue,
  };
}

function isTableConstraintDefinition(definition: string): boolean {
  return /^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(definition.trim());
}

function parseTableConstraintDefinition(
  definition: string,
  defaultSchema: string,
  tableRef: TableRef,
  ordinal: number
): ParsedConstraint | null {
  let working = definition.trim();
  if (!working) {
    return null;
  }

  let explicitName: string | null = null;
  const constraintPrefix = working.match(/^CONSTRAINT\s+/i);
  if (constraintPrefix) {
    const nameToken = readIdentifierToken(working, constraintPrefix[0].length);
    if (!nameToken) {
      return null;
    }
    explicitName = normalizeIdentifier(nameToken.token);
    working = working.slice(nameToken.nextIndex).trim();
  }

  const constraintType = resolveConstraintType(working);
  if (!constraintType) {
    return null;
  }
  const constraintName =
    explicitName ??
    buildSyntheticConstraintName(tableRef.tableName, constraintType, ordinal);

  if (constraintType === "FOREIGN KEY") {
    const localColumns = parseColumnsWithinKeywordParentheses(working, "FOREIGN KEY");
    const referencesMatch = working.match(/\bREFERENCES\s+/i);
    if (!referencesMatch) {
      return null;
    }
    const referencesStart = referencesMatch.index ?? 0;
    const referenceToken = readQualifiedIdentifier(
      working,
      referencesStart + referencesMatch[0].length
    );
    if (!referenceToken) {
      return null;
    }
    const referencedRef = toTableRef(referenceToken.parts, defaultSchema);

    const referenceColumnsRaw = tryReadNextParenthesizedContent(working, referenceToken.nextIndex);
    const referencedColumns = referenceColumnsRaw
      ? parseColumnList(referenceColumnsRaw)
      : [];
    const onUpdate = parseActionClause(working, "ON UPDATE");
    const onDelete = parseActionClause(working, "ON DELETE");

    return {
      constraint: {
        name: constraintName,
        type: "FOREIGN KEY",
        columns: localColumns,
        definition: normalizeWhitespace(working),
      },
      foreignKey: {
        name: constraintName,
        columns: localColumns,
        referencedSchema: referencedRef.schemaName,
        referencedTable: referencedRef.tableName,
        referencedColumns,
        onUpdate,
        onDelete,
      },
    };
  }

  return {
    constraint: {
      name: constraintName,
      type: constraintType,
      columns: parseColumnsWithinKeywordParentheses(working, constraintType),
      definition: normalizeWhitespace(working),
    },
    foreignKey: null,
  };
}

function resolveConstraintType(definition: string): string | null {
  const normalized = normalizeWhitespace(definition).toUpperCase();
  if (normalized.startsWith("PRIMARY KEY")) {
    return "PRIMARY KEY";
  }
  if (normalized.startsWith("UNIQUE")) {
    return "UNIQUE";
  }
  if (normalized.startsWith("FOREIGN KEY")) {
    return "FOREIGN KEY";
  }
  if (normalized.startsWith("CHECK")) {
    return "CHECK";
  }
  return null;
}

function parseColumnsWithinKeywordParentheses(
  definition: string,
  keyword: string
): string[] {
  const keywordMatch = definition.match(new RegExp(`^${escapeRegExp(keyword)}\\b`, "i"));
  if (!keywordMatch) {
    return [];
  }
  const content = tryReadNextParenthesizedContent(definition, keywordMatch[0].length);
  return content ? parseColumnList(content) : [];
}

function parseColumnList(content: string): string[] {
  return splitTopLevel(content, ",")
    .map((entry) => parseIndexedColumn(entry))
    .filter((entry) => entry.length > 0);
}

function parseIndexedColumn(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  const token = readIdentifierToken(trimmed, 0);
  if (!token) {
    return normalizeWhitespace(trimmed);
  }
  const remainder = trimmed.slice(token.nextIndex).trim();
  if (!remainder || /^(?:ASC|DESC|NULLS|COLLATE)\b/i.test(remainder)) {
    return normalizeIdentifier(token.token);
  }
  return normalizeWhitespace(trimmed);
}

function parseActionClause(definition: string, keyword: "ON UPDATE" | "ON DELETE"): string | null {
  const pattern = new RegExp(`${keyword}\\s+([A-Z\\s]+?)(?=\\s+ON\\s+(?:UPDATE|DELETE)\\b|$)`, "i");
  const match = definition.match(pattern);
  if (!match) {
    return null;
  }
  return normalizeWhitespace(match[1]);
}

function findTable(snapshot: SchemaSnapshot, ref: TableRef): SchemaSnapshotTable | null {
  return (
    snapshot.schemas
      .find((schema) => schema.name === ref.schemaName)
      ?.tables.find((table) => table.name === ref.tableName) ?? null
  );
}

function findTableEntry(
  snapshot: SchemaSnapshot,
  ref: TableRef
): { schema: SchemaSnapshotSchema; table: SchemaSnapshotTable } | null {
  const schema = snapshot.schemas.find((entry) => entry.name === ref.schemaName);
  if (!schema) {
    return null;
  }
  const table = schema.tables.find((entry) => entry.name === ref.tableName);
  if (!table) {
    return null;
  }
  return { schema, table };
}

function removeTable(snapshot: SchemaSnapshot, ref: TableRef): boolean {
  const schema = snapshot.schemas.find((entry) => entry.name === ref.schemaName);
  if (!schema) {
    return false;
  }
  const previousCount = schema.tables.length;
  schema.tables = schema.tables.filter((table) => table.name !== ref.tableName);
  return schema.tables.length !== previousCount;
}

function ensureSchema(snapshot: SchemaSnapshot, schemaName: string): SchemaSnapshotSchema {
  let schema = snapshot.schemas.find((entry) => entry.name === schemaName);
  if (!schema) {
    schema = {
      name: schemaName,
      tables: [],
      views: [],
      routines: [],
      functions: [],
      procedures: [],
    };
    snapshot.schemas.push(schema);
  }
  return schema;
}

function cloneSnapshot(snapshot: SchemaSnapshot): SchemaSnapshot {
  return {
    projectId: snapshot.projectId,
    envId: snapshot.envId,
    targetId: snapshot.targetId,
    capturedAt: snapshot.capturedAt,
    schemas: snapshot.schemas.map((schema) => ({
      name: schema.name,
      tables: schema.tables.map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          default: column.default,
        })),
        constraints: table.constraints.map((constraint) => ({
          name: constraint.name,
          type: constraint.type,
          columns: [...constraint.columns],
          definition: constraint.definition,
        })),
        foreignKeys: table.foreignKeys.map((foreignKey) => ({
          name: foreignKey.name,
          columns: [...foreignKey.columns],
          referencedSchema: foreignKey.referencedSchema,
          referencedTable: foreignKey.referencedTable,
          referencedColumns: [...foreignKey.referencedColumns],
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        })),
        indexes: table.indexes.map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          primary: index.primary,
          method: index.method,
          predicate: index.predicate,
        })),
      })),
      views: schema.views.map((view) => ({
        name: view.name,
        definition: view.definition,
      })),
      routines: schema.routines.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
      functions: schema.functions.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
      procedures: schema.procedures.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
    })),
  };
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    buffer = "";
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      buffer += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        buffer += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      buffer += char;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === "-" && next === "-") {
        buffer += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        buffer += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }
      const detectedTag = detectDollarTag(sql, index);
      if (detectedTag) {
        buffer += detectedTag;
        index += detectedTag.length - 1;
        dollarTag = detectedTag;
        continue;
      }
    }

    if (!inDouble && char === "'") {
      buffer += char;
      if (inSingle && next === "'") {
        buffer += next;
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      buffer += char;
      continue;
    }

    if (!inSingle && !inDouble && char === ";") {
      pushBuffer();
      continue;
    }

    buffer += char;
  }

  if (buffer.trim()) {
    pushBuffer();
  }

  return statements;
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inLineComment) {
      buffer += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === "-" && next === "-") {
        buffer += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        buffer += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }
    }

    if (!inDouble && char === "'") {
      buffer += char;
      if (inSingle && next === "'") {
        buffer += next;
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      buffer += char;
      continue;
    }

    if (inSingle || inDouble) {
      buffer += char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      buffer += char;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      buffer += char;
      continue;
    }

    if (depth === 0 && char === delimiter) {
      const trimmed = buffer.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      buffer = "";
      continue;
    }

    buffer += char;
  }

  const trimmed = buffer.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

function readParenthesizedBlock(
  input: string,
  openParenIndex: number
): { content: string; nextIndex: number } | null {
  if (openParenIndex < 0 || input[openParenIndex] !== "(") {
    return null;
  }
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let index = openParenIndex; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (!inDouble && char === "'") {
      if (inSingle && next === "'") {
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && char === '"') {
      if (inDouble && next === '"') {
        index += 1;
        continue;
      }
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: input.slice(openParenIndex + 1, index),
          nextIndex: index + 1,
        };
      }
    }
  }
  return null;
}

function tryReadNextParenthesizedContent(input: string, startIndex: number): string | null {
  const openParenIndex = indexOfNextNonWhitespace(input, startIndex);
  if (openParenIndex < 0 || input[openParenIndex] !== "(") {
    return null;
  }
  const parenthesized = readParenthesizedBlock(input, openParenIndex);
  return parenthesized?.content ?? null;
}

function readQualifiedIdentifier(
  input: string,
  startIndex: number
): { parts: string[]; nextIndex: number } | null {
  const parts: string[] = [];
  let cursor = skipWhitespace(input, startIndex);

  const firstPart = readIdentifierToken(input, cursor);
  if (!firstPart) {
    return null;
  }
  parts.push(firstPart.token);
  cursor = skipWhitespace(input, firstPart.nextIndex);

  if (input[cursor] === ".") {
    cursor = skipWhitespace(input, cursor + 1);
    const secondPart = readIdentifierToken(input, cursor);
    if (!secondPart) {
      return null;
    }
    parts.push(secondPart.token);
    cursor = secondPart.nextIndex;
  }

  return {
    parts,
    nextIndex: cursor,
  };
}

function readIdentifierToken(
  input: string,
  startIndex: number
): { token: string; nextIndex: number } | null {
  const cursor = skipWhitespace(input, startIndex);
  if (cursor >= input.length) {
    return null;
  }
  if (input[cursor] === '"') {
    let index = cursor + 1;
    while (index < input.length) {
      if (input[index] === '"') {
        if (input[index + 1] === '"') {
          index += 2;
          continue;
        }
        return {
          token: input.slice(cursor, index + 1),
          nextIndex: index + 1,
        };
      }
      index += 1;
    }
    return null;
  }

  const match = input.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
  if (!match) {
    return null;
  }
  return {
    token: match[0],
    nextIndex: cursor + match[0].length,
  };
}

function parseQualifiedIdentifier(value: string): string[] | null {
  const parsed = readQualifiedIdentifier(value, 0);
  if (!parsed) {
    return null;
  }
  const trailing = skipWhitespace(value, parsed.nextIndex);
  if (trailing < value.length) {
    return null;
  }
  return parsed.parts;
}

function toTableRef(parts: string[], defaultSchema: string): TableRef {
  if (parts.length === 1) {
    return {
      schemaName: defaultSchema,
      tableName: normalizeIdentifier(parts[0]),
    };
  }
  return {
    schemaName: normalizeIdentifier(parts[0]),
    tableName: normalizeIdentifier(parts[1]),
  };
}

function toQualifiedName(
  parts: string[],
  defaultSchema: string
): {
  schemaName: string;
  name: string;
} {
  if (parts.length === 1) {
    return {
      schemaName: "*",
      name: normalizeIdentifier(parts[0]),
    };
  }
  return {
    schemaName: normalizeIdentifier(parts[0]) || defaultSchema,
    name: normalizeIdentifier(parts[1]),
  };
}

function normalizeIdentifier(token: string): string {
  const trimmed = token.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function matchKeyword(
  input: string,
  startIndex: number,
  keyword: string
): { nextIndex: number } | null {
  const cursor = skipWhitespace(input, startIndex);
  const slice = input.slice(cursor);
  const match = slice.match(new RegExp(`^${escapeRegExp(keyword)}\\b`, "i"));
  if (!match) {
    return null;
  }
  return {
    nextIndex: cursor + match[0].length,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indexOfNextNonWhitespace(input: string, startIndex: number): number {
  for (let index = startIndex; index < input.length; index += 1) {
    if (!/\s/.test(input[index])) {
      return index;
    }
  }
  return -1;
}

function skipWhitespace(input: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < input.length && /\s/.test(input[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function trimDropQualifier(value: string): string {
  return value
    .trim()
    .replace(/\s+(?:CASCADE|RESTRICT)\b/gi, "")
    .trim();
}

function detectDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== "$") {
    return null;
  }
  const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
  return match ? match[0] : null;
}

function buildSyntheticConstraintName(
  tableName: string,
  type: string,
  ordinal: number
): string {
  const normalizedType = type.toLowerCase().replace(/\s+/g, "_");
  return `${tableName}_${normalizedType}_${ordinal}`;
}

function collectByName<T extends { name: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.name, item);
  }
  return map;
}

function collectUnionKeys<T>(left: Map<string, T>, right: Map<string, T>): string[] {
  const keys = new Set<string>();
  for (const key of left.keys()) {
    keys.add(key);
  }
  for (const key of right.keys()) {
    keys.add(key);
  }
  return Array.from(keys.values()).sort((a, b) => a.localeCompare(b));
}

function formatTableName(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function compareColumnChanges(
  left: MigrationDiffColumnChange,
  right: MigrationDiffColumnChange
): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  const tableCompare = left.tableName.localeCompare(right.tableName);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  return left.columnName.localeCompare(right.columnName);
}

function compareIndexChanges(
  left: MigrationDiffIndexChange,
  right: MigrationDiffIndexChange
): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  const tableCompare = left.tableName.localeCompare(right.tableName);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  return left.indexName.localeCompare(right.indexName);
}

function compareConstraintChanges(
  left: MigrationDiffConstraintChange,
  right: MigrationDiffConstraintChange
): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  const tableCompare = left.tableName.localeCompare(right.tableName);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  const nameCompare = left.constraintName.localeCompare(right.constraintName);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return rankKind(left.kind) - rankKind(right.kind);
}

function rankKind(kind: SchemaDiffKind): number {
  switch (kind) {
    case "added":
      return 0;
    case "removed":
      return 1;
    default:
      return 2;
  }
}
