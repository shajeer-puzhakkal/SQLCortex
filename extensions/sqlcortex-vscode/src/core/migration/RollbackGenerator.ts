import type {
  MigrationDiff,
  MigrationDiffColumnChange,
  MigrationDiffConstraintChange,
  MigrationDiffIndexChange,
} from "./MigrationDiffBuilder";

export type RollbackPlan = {
  sql: string[];
  warnings: string[];
};

type RollbackGeneratorInput = {
  migrationDiff: MigrationDiff;
};

const DEFAULT_SUMMARY_LABELS = {
  plan: "Rollback plan",
  warnings: "Rollback warnings",
} as const;

export function generateRollbackPlan(input: RollbackGeneratorInput): RollbackPlan {
  const rollbackSql: string[] = [];
  const warningSet = new Set<string>();
  const addedTables = new Set<string>();
  const removedTables = new Set<string>();

  for (const tableName of input.migrationDiff.tablesAdded) {
    const tableRef = parseQualifiedTableName(tableName);
    if (!tableRef) {
      continue;
    }
    addedTables.add(tableKey(tableRef.schemaName, tableRef.tableName));
  }
  for (const tableName of input.migrationDiff.tablesRemoved) {
    const tableRef = parseQualifiedTableName(tableName);
    if (!tableRef) {
      continue;
    }
    removedTables.add(tableKey(tableRef.schemaName, tableRef.tableName));
  }

  const constraintsToDrop = input.migrationDiff.constraintsChanged
    .filter((change) => change.kind === "added" || change.kind === "changed")
    .filter((change) => !isTableInSet(addedTables, change.schemaName, change.tableName))
    .sort(compareConstraintChanges);
  for (const change of constraintsToDrop) {
    rollbackSql.push(buildDropConstraintSql(change.schemaName, change.tableName, change.constraintName));
  }

  const indexesToDrop = input.migrationDiff.indexesAdded
    .filter((change) => !isTableInSet(addedTables, change.schemaName, change.tableName))
    .sort(compareIndexChanges);
  for (const change of indexesToDrop) {
    rollbackSql.push(buildDropIndexSql(change.schemaName, change.indexName));
  }

  const alteredColumns = input.migrationDiff.columnsAltered
    .filter(
      (change) =>
        !isTableInSet(addedTables, change.schemaName, change.tableName) &&
        !isTableInSet(removedTables, change.schemaName, change.tableName)
    )
    .sort(compareColumnChanges);
  for (const change of alteredColumns) {
    rollbackSql.push(...buildRevertAlteredColumnSql(change, warningSet));
  }

  const columnsToDrop = input.migrationDiff.columnsAdded
    .filter((change) => !isTableInSet(addedTables, change.schemaName, change.tableName))
    .sort(compareColumnChanges);
  for (const change of columnsToDrop) {
    rollbackSql.push(buildDropAddedColumnSql(change));
    warningSet.add(
      `Rollback drops ${change.schemaName}.${change.tableName}.${change.columnName}; any data written after migration is lost.`
    );
  }

  const columnsToRecreate = input.migrationDiff.columnsRemoved
    .filter((change) => !isTableInSet(removedTables, change.schemaName, change.tableName))
    .sort(compareColumnChanges);
  for (const change of columnsToRecreate) {
    rollbackSql.push(...buildRecreateRemovedColumnSql(change, warningSet));
  }

  const constraintsToRecreate = input.migrationDiff.constraintsChanged
    .filter((change) => change.kind === "removed" || change.kind === "changed")
    .filter((change) => !isTableInSet(removedTables, change.schemaName, change.tableName))
    .sort(compareConstraintChanges);
  for (const change of constraintsToRecreate) {
    const recreatedConstraint = buildRecreateConstraintSql(change, warningSet);
    if (recreatedConstraint) {
      rollbackSql.push(recreatedConstraint);
    }
  }

  const indexesToRecreate = input.migrationDiff.indexesRemoved
    .filter((change) => !isTableInSet(removedTables, change.schemaName, change.tableName))
    .sort(compareIndexChanges);
  for (const change of indexesToRecreate) {
    const indexSql = buildRecreateIndexSql(change, warningSet);
    if (indexSql) {
      rollbackSql.push(indexSql);
    }
  }

  const tablesToDrop = input.migrationDiff.tablesAdded
    .map(parseQualifiedTableName)
    .filter((entry): entry is { schemaName: string; tableName: string } => Boolean(entry))
    .sort(compareTableRefs);
  for (const tableRef of tablesToDrop) {
    rollbackSql.push(buildDropTableSql(tableRef.schemaName, tableRef.tableName));
    warningSet.add(
      `Rollback drops table ${tableRef.schemaName}.${tableRef.tableName}; rows inserted after migration are lost.`
    );
  }

  for (const tableName of input.migrationDiff.tablesRemoved) {
    const tableRef = parseQualifiedTableName(tableName);
    if (!tableRef) {
      continue;
    }
    warningSet.add(
      `Rollback cannot automatically restore dropped table ${tableRef.schemaName}.${tableRef.tableName} or its data.`
    );
  }

  return {
    sql: dedupeStatements(rollbackSql),
    warnings: Array.from(warningSet.values()).sort((left, right) => left.localeCompare(right)),
  };
}

export const generateMigrationRollbackPlan = generateRollbackPlan;

export function appendRollbackPlanToRiskSummary(
  summary: Array<{ label: string; value: string }>,
  rollbackPlan: RollbackPlan | null | undefined
): Array<{ label: string; value: string }> {
  if (!rollbackPlan) {
    return summary;
  }

  const withRollback = [...summary];
  withRollback.push({
    label: DEFAULT_SUMMARY_LABELS.plan,
    value: rollbackPlan.sql.length
      ? `${rollbackPlan.sql.length} statement(s) generated`
      : "No automatic rollback SQL generated",
  });
  withRollback.push({
    label: DEFAULT_SUMMARY_LABELS.warnings,
    value: rollbackPlan.warnings.length ? rollbackPlan.warnings.join("; ") : "None",
  });

  return withRollback;
}

function buildDropTableSql(schemaName: string, tableName: string): string {
  return `DROP TABLE IF EXISTS ${formatQualifiedName(schemaName, tableName)};`;
}

function buildDropAddedColumnSql(change: MigrationDiffColumnChange): string {
  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const columnName = formatIdentifier(change.columnName);
  return `ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${columnName};`;
}

function buildRevertAlteredColumnSql(
  change: MigrationDiffColumnChange,
  warningSet: Set<string>
): string[] {
  const previous = change.previous;
  const next = change.next;
  if (!previous || !next) {
    warningSet.add(
      `Rollback could not infer full prior definition for ${change.schemaName}.${change.tableName}.${change.columnName}.`
    );
    return [];
  }

  const sql: string[] = [];
  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const columnName = formatIdentifier(change.columnName);
  if (normalizeDataType(previous.dataType) !== normalizeDataType(next.dataType)) {
    const priorType = normalizeWhitespace(previous.dataType);
    sql.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${priorType} USING ${columnName}::${priorType};`
    );
    warningSet.add(
      `Rollback type conversion for ${change.schemaName}.${change.tableName}.${change.columnName} may fail or truncate incompatible values.`
    );
  }

  if (normalizeOptionalValue(previous.default) !== normalizeOptionalValue(next.default)) {
    const previousDefault = normalizeOptionalExpression(previous.default);
    if (previousDefault) {
      sql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${previousDefault};`);
    } else {
      sql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT;`);
    }
  }

  if (previous.nullable !== next.nullable) {
    sql.push(
      previous.nullable
        ? `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL;`
        : `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL;`
    );
  }

  return sql;
}

function buildRecreateRemovedColumnSql(
  change: MigrationDiffColumnChange,
  warningSet: Set<string>
): string[] {
  const previous = change.previous;
  if (!previous) {
    warningSet.add(
      `Rollback could not infer column definition for ${change.schemaName}.${change.tableName}.${change.columnName}.`
    );
    return [];
  }

  const sql: string[] = [];
  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const columnName = formatIdentifier(change.columnName);
  const dataType = normalizeWhitespace(previous.dataType);

  sql.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${dataType};`);

  const previousDefault = normalizeOptionalExpression(previous.default);
  if (previousDefault) {
    sql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${previousDefault};`);
  }
  if (!previous.nullable) {
    sql.push(`-- Backfill ${columnName} before enforcing NOT NULL.`);
    sql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL;`);
    warningSet.add(
      `Rollback re-creates NOT NULL column ${change.schemaName}.${change.tableName}.${change.columnName}; manual backfill may be required.`
    );
  }
  warningSet.add(
    `Rollback re-creates ${change.schemaName}.${change.tableName}.${change.columnName}, but removed column values cannot be recovered automatically.`
  );

  return sql;
}

function buildDropIndexSql(schemaName: string, indexName: string): string {
  return `DROP INDEX IF EXISTS ${formatQualifiedName(schemaName, indexName)};`;
}

function buildRecreateIndexSql(
  change: MigrationDiffIndexChange,
  warningSet: Set<string>
): string | null {
  const previous = change.previous;
  if (!previous) {
    warningSet.add(
      `Rollback could not infer index definition for ${change.schemaName}.${change.tableName}.${change.indexName}.`
    );
    return null;
  }
  if (previous.primary) {
    warningSet.add(
      `Rollback skipped ${change.schemaName}.${change.tableName}.${change.indexName}; primary indexes should be restored through constraints.`
    );
    return null;
  }

  const indexName = formatQualifiedName(change.schemaName, change.indexName);
  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const uniquePrefix = previous.unique ? "UNIQUE " : "";
  const method = normalizeOptionalExpression(previous.method);
  const usingClause = method ? ` USING ${method}` : "";
  const columns = previous.columns.map((column) => formatIdentifier(column)).join(", ");
  const predicate = normalizeOptionalExpression(previous.predicate);
  const predicateClause = predicate ? ` WHERE ${predicate}` : "";

  return `CREATE ${uniquePrefix}INDEX IF NOT EXISTS ${indexName} ON ${tableName}${usingClause} (${columns})${predicateClause};`;
}

function buildDropConstraintSql(schemaName: string, tableName: string, constraintName: string): string {
  const qualifiedTable = formatQualifiedName(schemaName, tableName);
  return `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT IF EXISTS ${formatIdentifier(constraintName)};`;
}

function buildRecreateConstraintSql(
  change: MigrationDiffConstraintChange,
  warningSet: Set<string>
): string | null {
  const previous = change.previous;
  if (!previous) {
    warningSet.add(
      `Rollback could not infer prior constraint for ${change.schemaName}.${change.tableName}.${change.constraintName}.`
    );
    return null;
  }

  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const constraintName = formatIdentifier(change.constraintName);
  if (change.source === "foreignKey" && isForeignKeyConstraint(previous)) {
    const columns = previous.columns.map((column) => formatIdentifier(column)).join(", ");
    const referencedTable = formatQualifiedName(previous.referencedSchema, previous.referencedTable);
    const referencedColumns = previous.referencedColumns
      .map((column) => formatIdentifier(column))
      .join(", ");
    const onUpdate = normalizeOptionalExpression(previous.onUpdate);
    const onDelete = normalizeOptionalExpression(previous.onDelete);
    const onUpdateClause = onUpdate ? ` ON UPDATE ${onUpdate}` : "";
    const onDeleteClause = onDelete ? ` ON DELETE ${onDelete}` : "";
    return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})${onUpdateClause}${onDeleteClause};`;
  }

  if (change.source === "constraint" && isTableConstraint(previous)) {
    const definition = normalizeOptionalExpression(previous.definition);
    if (definition) {
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition};`;
    }
    const type = normalizeWhitespace(previous.type).toUpperCase();
    const columns = previous.columns.map((column) => formatIdentifier(column)).join(", ");
    if ((type === "PRIMARY KEY" || type === "UNIQUE") && columns.length > 0) {
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${type} (${columns});`;
    }
    if (type === "CHECK") {
      warningSet.add(
        `Rollback cannot reconstruct CHECK definition for ${change.schemaName}.${change.tableName}.${change.constraintName}.`
      );
      return null;
    }
    if (columns.length > 0) {
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${type} (${columns});`;
    }
  }

  warningSet.add(
    `Rollback could not generate SQL for constraint ${change.schemaName}.${change.tableName}.${change.constraintName}.`
  );
  return null;
}

function isForeignKeyConstraint(value: MigrationDiffConstraintChange["previous"]): value is {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    Array.isArray(candidate.columns) &&
    typeof candidate.referencedSchema === "string" &&
    typeof candidate.referencedTable === "string" &&
    Array.isArray(candidate.referencedColumns)
  );
}

function isTableConstraint(value: MigrationDiffConstraintChange["previous"]): value is {
  name: string;
  type: string;
  columns: string[];
  definition: string | null;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    Array.isArray(candidate.columns)
  );
}

function dedupeStatements(statements: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const statement of statements) {
    const normalized = normalizeWhitespace(statement);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(statement);
  }
  return deduped;
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

function compareTableRefs(
  left: { schemaName: string; tableName: string },
  right: { schemaName: string; tableName: string }
): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  return left.tableName.localeCompare(right.tableName);
}

function compareColumnChanges(left: MigrationDiffColumnChange, right: MigrationDiffColumnChange): number {
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

function compareIndexChanges(left: MigrationDiffIndexChange, right: MigrationDiffIndexChange): number {
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
  return left.constraintName.localeCompare(right.constraintName);
}

function isTableInSet(set: Set<string>, schemaName: string, tableName: string): boolean {
  return set.has(tableKey(schemaName, tableName));
}

function tableKey(schemaName: string, tableName: string): string {
  return `${normalizeIdentifier(schemaName)}.${normalizeIdentifier(tableName)}`;
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase();
  }
  return trimmed.toLowerCase();
}

function formatQualifiedName(schemaName: string, name: string): string {
  return `${formatIdentifier(schemaName)}.${formatIdentifier(name)}`;
}

function formatIdentifier(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z_][a-z0-9_$]*$/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalExpression(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalValue(value: string | null): string {
  return normalizeWhitespace(value ?? "").toLowerCase();
}

function normalizeDataType(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}
