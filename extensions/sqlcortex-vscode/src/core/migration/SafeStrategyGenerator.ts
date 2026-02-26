import type { RiskLevel, RiskScore } from "./RiskScorer";
import type {
  MigrationDiff,
  MigrationDiffColumnChange,
  MigrationDiffConstraintChange,
  MigrationDiffIndexChange,
} from "./MigrationDiffBuilder";

export type SafeStrategyPhase = {
  title: string;
  sql: string[];
};

export type SafeStrategyPlan = {
  recommended: boolean;
  riskLevel: RiskLevel;
  explanation: string[];
  phases: SafeStrategyPhase[];
  sql: string[];
};

export type SafeStrategyGeneratorInput = {
  migrationDiff: MigrationDiff;
  riskScore: RiskScore;
  statements?: string[];
};

export function generateSafeStrategy(input: SafeStrategyGeneratorInput): SafeStrategyPlan {
  const riskLevel = input.riskScore.level;
  if (!isHighRisk(riskLevel)) {
    return {
      recommended: false,
      riskLevel,
      explanation: [
        `Risk level is ${riskLevel}; safer phased strategy is optional and not auto-generated.`,
      ],
      phases: [],
      sql: [],
    };
  }

  const phases: SafeStrategyPhase[] = [];
  const explanation: string[] = [
    `Risk level ${riskLevel} triggered phased strategy generation to reduce lock and rewrite pressure.`,
  ];

  const addedTables = new Set<string>(input.migrationDiff.tablesAdded.map((name) => normalizeIdentifier(name)));
  const removedTables = new Set<string>(
    input.migrationDiff.tablesRemoved.map((name) => normalizeIdentifier(name))
  );

  for (const change of input.migrationDiff.columnsAdded) {
    if (isTableInSet(addedTables, change.schemaName, change.tableName)) {
      continue;
    }
    if (pushAddedColumnPhase(phases, change)) {
      explanation.push(
        `Rewrote ${change.schemaName}.${change.tableName}.${change.columnName} into expand/backfill/contract steps.`
      );
    }
  }

  for (const change of input.migrationDiff.columnsAltered) {
    if (isTableInSet(addedTables, change.schemaName, change.tableName)) {
      continue;
    }
    if (pushTypeChangePhase(phases, change)) {
      explanation.push(
        `Added shadow-column strategy for type change on ${change.schemaName}.${change.tableName}.${change.columnName}.`
      );
    }
  }

  for (const change of input.migrationDiff.columnsRemoved) {
    if (isTableInSet(addedTables, change.schemaName, change.tableName)) {
      continue;
    }
    if (pushDropColumnPhase(phases, change)) {
      explanation.push(
        `Converted immediate drop to deprecation flow for ${change.schemaName}.${change.tableName}.${change.columnName}.`
      );
    }
  }

  for (const tableName of input.migrationDiff.tablesRemoved) {
    if (pushDropTablePhase(phases, tableName)) {
      explanation.push(`Converted immediate DROP TABLE ${tableName} into quarantine-then-drop flow.`);
    }
  }

  for (const change of input.migrationDiff.indexesAdded) {
    if (
      isTableInSet(addedTables, change.schemaName, change.tableName) ||
      isTableInSet(removedTables, change.schemaName, change.tableName)
    ) {
      continue;
    }
    if (pushIndexCreatePhase(phases, change)) {
      explanation.push(
        `Suggested CREATE INDEX CONCURRENTLY for ${change.schemaName}.${change.indexName} to reduce blocking.`
      );
    }
  }

  for (const change of input.migrationDiff.constraintsChanged) {
    if (pushForeignKeyPhase(phases, change)) {
      explanation.push(
        `Replaced immediate foreign key validation with NOT VALID + VALIDATE for ${change.schemaName}.${change.constraintName}.`
      );
    }
  }

  if (phases.length === 0) {
    phases.push(buildFallbackPhase(input.statements));
    explanation.push(
      "No deterministic rewrite pattern matched; use staged execution with explicit validation checkpoints."
    );
  }

  return {
    recommended: true,
    riskLevel,
    explanation,
    phases,
    sql: flattenPhases(phases),
  };
}

export const generateSafeMigrationStrategy = generateSafeStrategy;

function pushAddedColumnPhase(phases: SafeStrategyPhase[], change: MigrationDiffColumnChange): boolean {
  const nextColumn = change.next;
  if (!nextColumn) {
    return false;
  }
  if (nextColumn.nullable && !hasNonEmptyValue(nextColumn.default)) {
    return false;
  }

  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const columnName = formatIdentifier(change.columnName);
  const dataType = normalizeWhitespace(nextColumn.dataType);
  const defaultExpression = normalizeOptionalExpression(nextColumn.default);

  phases.push({
    title: `Expand ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [
      `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${dataType} NULL;`,
    ],
  });

  const backfillStatement = defaultExpression
    ? `UPDATE ${tableName} SET ${columnName} = ${defaultExpression} WHERE ${columnName} IS NULL;`
    : `-- TODO: Backfill ${columnName} before enforcing NOT NULL.`;
  phases.push({
    title: `Backfill ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [backfillStatement],
  });

  const contractSql: string[] = [];
  if (defaultExpression) {
    contractSql.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${defaultExpression};`
    );
  }
  if (!nextColumn.nullable) {
    contractSql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL;`);
  }
  if (contractSql.length > 0) {
    phases.push({
      title: `Contract ${change.schemaName}.${change.tableName}.${change.columnName}`,
      sql: contractSql,
    });
  }

  return true;
}

function pushTypeChangePhase(phases: SafeStrategyPhase[], change: MigrationDiffColumnChange): boolean {
  if (!hasColumnTypeChanged(change)) {
    return false;
  }
  const nextColumn = change.next;
  if (!nextColumn) {
    return false;
  }

  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const sourceColumn = formatIdentifier(change.columnName);
  const shadowNameRaw = `${change.columnName}__new`;
  const shadowColumn = formatIdentifier(shadowNameRaw);
  const dataType = normalizeWhitespace(nextColumn.dataType);
  const defaultExpression = normalizeOptionalExpression(nextColumn.default);

  phases.push({
    title: `Create shadow column for ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${shadowColumn} ${dataType} NULL;`],
  });

  phases.push({
    title: `Backfill shadow column ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [
      `UPDATE ${tableName} SET ${shadowColumn} = CASE WHEN ${sourceColumn} IS NULL THEN NULL ELSE ${sourceColumn}::${dataType} END WHERE ${shadowColumn} IS NULL;`,
    ],
  });

  const cutoverSql: string[] = [];
  if (defaultExpression) {
    cutoverSql.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${shadowColumn} SET DEFAULT ${defaultExpression};`
    );
  }
  if (!nextColumn.nullable) {
    cutoverSql.push(`ALTER TABLE ${tableName} ALTER COLUMN ${shadowColumn} SET NOT NULL;`);
  }
  cutoverSql.push(`ALTER TABLE ${tableName} DROP COLUMN ${sourceColumn};`);
  cutoverSql.push(`ALTER TABLE ${tableName} RENAME COLUMN ${shadowColumn} TO ${sourceColumn};`);
  phases.push({
    title: `Cut over ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: cutoverSql,
  });

  return true;
}

function pushDropColumnPhase(phases: SafeStrategyPhase[], change: MigrationDiffColumnChange): boolean {
  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const sourceColumnRaw = change.columnName;
  const sourceColumn = formatIdentifier(sourceColumnRaw);
  const deprecatedColumnRaw = `${sourceColumnRaw}__deprecated`;
  const deprecatedColumn = formatIdentifier(deprecatedColumnRaw);

  phases.push({
    title: `Deprecate ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [`ALTER TABLE ${tableName} RENAME COLUMN ${sourceColumn} TO ${deprecatedColumn};`],
  });
  phases.push({
    title: `Drop deprecated ${change.schemaName}.${change.tableName}.${change.columnName}`,
    sql: [
      `-- Run this drop only after application reads/writes stop using ${sourceColumn}.`,
      `ALTER TABLE ${tableName} DROP COLUMN ${deprecatedColumn};`,
    ],
  });
  return true;
}

function pushDropTablePhase(phases: SafeStrategyPhase[], qualifiedTableName: string): boolean {
  const parsed = parseQualifiedTableName(qualifiedTableName);
  if (!parsed) {
    return false;
  }
  const tableName = formatQualifiedName(parsed.schemaName, parsed.tableName);
  const quarantineNameRaw = `${parsed.tableName}__to_delete`;
  const quarantineName = formatIdentifier(quarantineNameRaw);
  const quarantinedQualified = formatQualifiedName(parsed.schemaName, quarantineNameRaw);

  phases.push({
    title: `Quarantine table ${qualifiedTableName}`,
    sql: [`ALTER TABLE ${tableName} RENAME TO ${quarantineName};`],
  });
  phases.push({
    title: `Drop quarantined table ${qualifiedTableName}`,
    sql: [
      `-- Execute DROP TABLE only after backup/verification checks pass.`,
      `DROP TABLE ${quarantinedQualified};`,
    ],
  });
  return true;
}

function pushIndexCreatePhase(phases: SafeStrategyPhase[], change: MigrationDiffIndexChange): boolean {
  const nextIndex = change.next;
  if (!nextIndex) {
    return false;
  }
  if (nextIndex.primary) {
    return false;
  }

  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const indexName = formatQualifiedName(change.schemaName, change.indexName);
  const columns = nextIndex.columns.map((entry) => formatIdentifier(entry)).join(", ");
  const method = normalizeWhitespace(nextIndex.method || "");
  const usingClause = method ? ` USING ${method}` : "";
  const predicate = normalizeOptionalExpression(nextIndex.predicate);
  const predicateClause = predicate ? ` WHERE ${predicate}` : "";
  const uniquePrefix = nextIndex.unique ? "UNIQUE " : "";

  phases.push({
    title: `Build index concurrently ${change.schemaName}.${change.indexName}`,
    sql: [
      `CREATE ${uniquePrefix}INDEX CONCURRENTLY ${indexName} ON ${tableName}${usingClause} (${columns})${predicateClause};`,
    ],
  });
  return true;
}

function pushForeignKeyPhase(phases: SafeStrategyPhase[], change: MigrationDiffConstraintChange): boolean {
  if (change.source !== "foreignKey" || change.kind !== "added") {
    return false;
  }
  const nextForeignKey = change.next;
  if (!nextForeignKey || !isForeignKeySnapshot(nextForeignKey)) {
    return false;
  }

  const tableName = formatQualifiedName(change.schemaName, change.tableName);
  const constraintName = formatIdentifier(change.constraintName);
  const columns = nextForeignKey.columns.map((column) => formatIdentifier(column)).join(", ");
  const referencedTable = formatQualifiedName(
    nextForeignKey.referencedSchema,
    nextForeignKey.referencedTable
  );
  const referencedColumns = nextForeignKey.referencedColumns
    .map((column) => formatIdentifier(column))
    .join(", ");
  const onUpdate = normalizeOptionalExpression(nextForeignKey.onUpdate);
  const onDelete = normalizeOptionalExpression(nextForeignKey.onDelete);
  const updateClause = onUpdate ? ` ON UPDATE ${onUpdate}` : "";
  const deleteClause = onDelete ? ` ON DELETE ${onDelete}` : "";

  phases.push({
    title: `Add FK without immediate validation ${change.schemaName}.${change.constraintName}`,
    sql: [
      `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})${updateClause}${deleteClause} NOT VALID;`,
    ],
  });
  phases.push({
    title: `Validate FK ${change.schemaName}.${change.constraintName}`,
    sql: [`ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${constraintName};`],
  });
  return true;
}

function buildFallbackPhase(statements: string[] | undefined): SafeStrategyPhase {
  if (!statements || statements.length === 0) {
    return {
      title: "Stage execution with checkpoints",
      sql: [
        "-- No SQL statements supplied. Execute the migration in small batches with validation checks between steps.",
      ],
    };
  }

  const sql: string[] = ["-- Execute each statement separately and validate impact between steps."];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = normalizeStatement(statements[index]);
    sql.push(`-- Step ${index + 1}`);
    sql.push(statement);
  }

  return {
    title: "Stage execution with checkpoints",
    sql,
  };
}

function flattenPhases(phases: SafeStrategyPhase[]): string[] {
  const flattened: string[] = [];
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    flattened.push(`-- ${phase.title}`);
    for (const statement of phase.sql) {
      flattened.push(statement);
    }
    if (index < phases.length - 1) {
      flattened.push("");
    }
  }
  return flattened;
}

function hasColumnTypeChanged(change: MigrationDiffColumnChange): boolean {
  if (!change.previous || !change.next) {
    return false;
  }
  return normalizeWhitespace(change.previous.dataType).toLowerCase() !==
    normalizeWhitespace(change.next.dataType).toLowerCase();
}

function isHighRisk(level: RiskLevel): boolean {
  return level === "HIGH" || level === "CRITICAL";
}

function isTableInSet(set: Set<string>, schemaName: string, tableName: string): boolean {
  return set.has(`${normalizeIdentifier(schemaName)}.${normalizeIdentifier(tableName)}`);
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

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase();
  }
  return trimmed.toLowerCase();
}

function normalizeStatement(statement: string): string {
  const trimmed = statement.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function normalizeOptionalExpression(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasNonEmptyValue(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isForeignKeySnapshot(value: MigrationDiffConstraintChange["next"]): value is {
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
