import type {
  MigrationDiff,
  MigrationDiffColumnChange,
  MigrationDiffConstraintChange,
  MigrationDiffIndexChange,
} from "./MigrationDiffBuilder";
import type { SchemaSnapshot } from "../schema/SchemaTypes";

export type LockImpact = {
  lockType: string;
  rewriteRequired: boolean;
  estimatedRowsTouched: number;
  estimatedLockSeverity: "LOW" | "MEDIUM" | "HIGH";
};

type LockEstimatorInput = {
  migrationDiff: MigrationDiff;
  snapshotBefore: SchemaSnapshot;
  statements?: string[];
  defaultSchema?: string;
};

type LockSeverity = LockImpact["estimatedLockSeverity"];

type LockSignal = {
  lockType: string;
  rewriteRequired: boolean;
  estimatedRowsTouched: number;
  estimatedLockSeverity: LockSeverity;
};

type TableRef = {
  schemaName: string;
  tableName: string;
};

type IndexIdentity = {
  schemaName: string;
  name: string;
};

type ConcurrentIndexHints = {
  createByTableIndex: Set<string>;
  createByIndex: Set<string>;
  dropBySchemaIndex: Set<string>;
  dropByIndex: Set<string>;
};

const DEFAULT_SCHEMA_NAME = "public";

const LOCK_SEVERITY_RANK: Record<LockSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const LOCK_TYPE_RANK: Record<string, number> = {
  NONE: 0,
  "SHARE UPDATE EXCLUSIVE": 1,
  "SHARE ROW EXCLUSIVE": 2,
  SHARE: 3,
  EXCLUSIVE: 4,
  "ACCESS EXCLUSIVE": 5,
};

export function estimateLockImpact(input: LockEstimatorInput): LockImpact {
  const rowCountByTable = buildTableRowCountIndex(input.snapshotBefore);
  const concurrentHints = collectConcurrentIndexHints(
    input.statements ?? [],
    input.defaultSchema ?? DEFAULT_SCHEMA_NAME
  );
  const signals: LockSignal[] = [];

  for (const tableName of input.migrationDiff.tablesAdded) {
    const tableRef = parseQualifiedTableName(tableName);
    if (!tableRef) {
      continue;
    }
    // CREATE TABLE only locks the new relation and should remain low risk.
    signals.push(makeSignal("ACCESS EXCLUSIVE", "LOW", false, 0));
  }

  for (const tableName of input.migrationDiff.tablesRemoved) {
    const tableRef = parseQualifiedTableName(tableName);
    if (!tableRef) {
      continue;
    }
    const rowCount = lookupRowCount(rowCountByTable, tableRef.schemaName, tableRef.tableName);
    signals.push(makeSignal("ACCESS EXCLUSIVE", "HIGH", false, rowCount));
  }

  for (const change of input.migrationDiff.columnsAdded) {
    signals.push(estimateAddedColumnLock(change, rowCountByTable));
  }

  for (const change of input.migrationDiff.columnsRemoved) {
    const rowCount = lookupRowCount(rowCountByTable, change.schemaName, change.tableName);
    signals.push(makeSignal("ACCESS EXCLUSIVE", "HIGH", false, rowCount));
  }

  for (const change of input.migrationDiff.columnsAltered) {
    signals.push(estimateAlteredColumnLock(change, rowCountByTable));
  }

  for (const change of input.migrationDiff.indexesAdded) {
    const rowCount = lookupRowCount(rowCountByTable, change.schemaName, change.tableName);
    const concurrent = isConcurrentCreateIndex(change, concurrentHints);
    if (concurrent) {
      signals.push(makeSignal("SHARE UPDATE EXCLUSIVE", "LOW", false, rowCount));
    } else {
      signals.push(makeSignal("SHARE", "MEDIUM", false, rowCount));
    }
  }

  for (const change of input.migrationDiff.indexesRemoved) {
    const concurrent = isConcurrentDropIndex(change, concurrentHints);
    if (concurrent) {
      signals.push(makeSignal("SHARE UPDATE EXCLUSIVE", "LOW", false, 0));
    } else {
      signals.push(makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, 0));
    }
  }

  for (const change of input.migrationDiff.constraintsChanged) {
    signals.push(estimateConstraintLock(change, rowCountByTable));
  }

  return aggregateSignals(signals);
}

function estimateAddedColumnLock(
  change: MigrationDiffColumnChange,
  rowCountByTable: Map<string, number>
): LockSignal {
  const nextColumn = change.next;
  const rowCount = lookupRowCount(rowCountByTable, change.schemaName, change.tableName);
  if (!nextColumn) {
    return makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, 0);
  }

  const hasDefault = hasNonEmptyValue(nextColumn.default);
  if (nextColumn.nullable && !hasDefault) {
    // Acceptance criterion: ADD COLUMN NULL should classify as LOW.
    return makeSignal("ACCESS EXCLUSIVE", "LOW", false, 0);
  }
  if (hasDefault && !nextColumn.nullable) {
    // Acceptance criterion: ADD COLUMN DEFAULT NOT NULL should detect rewrite.
    return makeSignal("ACCESS EXCLUSIVE", "HIGH", true, rowCount);
  }
  if (hasDefault) {
    return makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, rowCount);
  }
  if (!nextColumn.nullable) {
    return makeSignal("ACCESS EXCLUSIVE", "HIGH", false, rowCount);
  }

  return makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, 0);
}

function estimateAlteredColumnLock(
  change: MigrationDiffColumnChange,
  rowCountByTable: Map<string, number>
): LockSignal {
  const previous = change.previous;
  const next = change.next;
  const rowCount = lookupRowCount(rowCountByTable, change.schemaName, change.tableName);

  if (previous && next && normalizeDataType(previous.dataType) !== normalizeDataType(next.dataType)) {
    return makeSignal("ACCESS EXCLUSIVE", "HIGH", true, rowCount);
  }
  if (previous && next && previous.nullable && !next.nullable) {
    return makeSignal("SHARE UPDATE EXCLUSIVE", "MEDIUM", false, rowCount);
  }
  if (previous && next && !previous.nullable && next.nullable) {
    return makeSignal("SHARE UPDATE EXCLUSIVE", "LOW", false, 0);
  }
  if (previous && next && normalizeOptional(previous.default) !== normalizeOptional(next.default)) {
    return makeSignal("SHARE UPDATE EXCLUSIVE", "LOW", false, 0);
  }

  return makeSignal("SHARE UPDATE EXCLUSIVE", "MEDIUM", false, 0);
}

function estimateConstraintLock(
  change: MigrationDiffConstraintChange,
  rowCountByTable: Map<string, number>
): LockSignal {
  const rowCount = lookupRowCount(rowCountByTable, change.schemaName, change.tableName);

  if (change.source === "foreignKey") {
    if (change.kind === "added") {
      return makeSignal("SHARE ROW EXCLUSIVE", "MEDIUM", false, rowCount);
    }
    return makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, rowCount);
  }

  const constraintType = readConstraintType(change);
  if (constraintType === "CHECK" && change.kind === "added") {
    return makeSignal("SHARE UPDATE EXCLUSIVE", "MEDIUM", false, rowCount);
  }
  if (
    (constraintType === "PRIMARY KEY" || constraintType === "UNIQUE") &&
    change.kind === "added"
  ) {
    return makeSignal("ACCESS EXCLUSIVE", "HIGH", false, rowCount);
  }

  return makeSignal("ACCESS EXCLUSIVE", "MEDIUM", false, 0);
}

function readConstraintType(change: MigrationDiffConstraintChange): string | null {
  if (change.source !== "constraint") {
    return null;
  }
  const value = change.next ?? change.previous;
  if (!value || typeof value !== "object") {
    return null;
  }
  if (!("type" in value) || typeof value.type !== "string") {
    return null;
  }
  return normalizeWhitespace(value.type).toUpperCase();
}

function aggregateSignals(signals: LockSignal[]): LockImpact {
  if (signals.length === 0) {
    return {
      lockType: "NONE",
      rewriteRequired: false,
      estimatedRowsTouched: 0,
      estimatedLockSeverity: "LOW",
    };
  }

  let highestLockType = "NONE";
  let highestLockRank = 0;
  let highestSeverityRank = LOCK_SEVERITY_RANK.LOW;
  let rewriteRequired = false;
  let estimatedRowsTouched = 0;

  for (const signal of signals) {
    const lockRank = LOCK_TYPE_RANK[signal.lockType] ?? 0;
    if (lockRank > highestLockRank) {
      highestLockRank = lockRank;
      highestLockType = signal.lockType;
    }
    const severityRank = LOCK_SEVERITY_RANK[signal.estimatedLockSeverity];
    if (severityRank > highestSeverityRank) {
      highestSeverityRank = severityRank;
    }
    if (signal.rewriteRequired) {
      rewriteRequired = true;
    }
    estimatedRowsTouched += signal.estimatedRowsTouched;
  }

  estimatedRowsTouched = Math.max(0, Math.round(estimatedRowsTouched));

  if (estimatedRowsTouched >= 1_000_000 && highestSeverityRank < LOCK_SEVERITY_RANK.MEDIUM) {
    highestSeverityRank = LOCK_SEVERITY_RANK.MEDIUM;
  }
  if (
    rewriteRequired &&
    estimatedRowsTouched >= 100_000 &&
    highestSeverityRank < LOCK_SEVERITY_RANK.HIGH
  ) {
    highestSeverityRank = LOCK_SEVERITY_RANK.HIGH;
  }

  return {
    lockType: highestLockType,
    rewriteRequired,
    estimatedRowsTouched,
    estimatedLockSeverity: toSeverity(highestSeverityRank),
  };
}

function toSeverity(rank: number): LockSeverity {
  if (rank >= LOCK_SEVERITY_RANK.HIGH) {
    return "HIGH";
  }
  if (rank >= LOCK_SEVERITY_RANK.MEDIUM) {
    return "MEDIUM";
  }
  return "LOW";
}

function makeSignal(
  lockType: string,
  estimatedLockSeverity: LockSeverity,
  rewriteRequired: boolean,
  estimatedRowsTouched: number
): LockSignal {
  return {
    lockType,
    rewriteRequired,
    estimatedRowsTouched: Math.max(0, Math.round(estimatedRowsTouched)),
    estimatedLockSeverity,
  };
}

function isConcurrentCreateIndex(
  change: MigrationDiffIndexChange,
  hints: ConcurrentIndexHints
): boolean {
  const byTableIndex = tableIndexKey(change.schemaName, change.tableName, change.indexName);
  if (hints.createByTableIndex.has(byTableIndex)) {
    return true;
  }
  const byIndex = indexKey(change.schemaName, change.indexName);
  return hints.createByIndex.has(byIndex);
}

function isConcurrentDropIndex(
  change: MigrationDiffIndexChange,
  hints: ConcurrentIndexHints
): boolean {
  const bySchemaIndex = indexKey(change.schemaName, change.indexName);
  if (hints.dropBySchemaIndex.has(bySchemaIndex)) {
    return true;
  }
  return hints.dropByIndex.has(normalizeIdentifier(change.indexName));
}

function collectConcurrentIndexHints(
  statements: string[],
  defaultSchema: string
): ConcurrentIndexHints {
  const hints: ConcurrentIndexHints = {
    createByTableIndex: new Set<string>(),
    createByIndex: new Set<string>(),
    dropBySchemaIndex: new Set<string>(),
    dropByIndex: new Set<string>(),
  };

  for (const statement of statements) {
    const create = parseCreateIndexConcurrency(statement, defaultSchema);
    if (create && create.concurrent) {
      hints.createByTableIndex.add(
        tableIndexKey(create.tableRef.schemaName, create.tableRef.tableName, create.index.name)
      );
      hints.createByIndex.add(indexKey(create.index.schemaName, create.index.name));
      continue;
    }

    const drop = parseDropIndexConcurrency(statement, defaultSchema);
    if (!drop || !drop.concurrent) {
      continue;
    }
    for (const index of drop.indexes) {
      hints.dropBySchemaIndex.add(indexKey(index.schemaName, index.name));
      hints.dropByIndex.add(normalizeIdentifier(index.name));
    }
  }

  return hints;
}

function parseCreateIndexConcurrency(
  statement: string,
  defaultSchema: string
): { concurrent: boolean; index: IndexIdentity; tableRef: TableRef } | null {
  const prefixMatch = statement.match(
    /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i
  );
  if (!prefixMatch) {
    return null;
  }

  const concurrent = /\bCONCURRENTLY\b/i.test(prefixMatch[0]);
  const parsedIndexName = readQualifiedIdentifier(statement, prefixMatch[0].length);
  if (!parsedIndexName) {
    return null;
  }
  const index = toQualifiedIndex(parsedIndexName.parts, defaultSchema);
  const onKeywordMatch = matchKeyword(statement, parsedIndexName.nextIndex, "ON");
  if (!onKeywordMatch) {
    return null;
  }

  let cursor = onKeywordMatch.nextIndex;
  const onlyKeywordMatch = matchKeyword(statement, cursor, "ONLY");
  if (onlyKeywordMatch) {
    cursor = onlyKeywordMatch.nextIndex;
  }

  const parsedTableName = readQualifiedIdentifier(statement, cursor);
  if (!parsedTableName) {
    return null;
  }

  return {
    concurrent,
    index,
    tableRef: toTableRef(parsedTableName.parts, defaultSchema),
  };
}

function parseDropIndexConcurrency(
  statement: string,
  defaultSchema: string
): { concurrent: boolean; indexes: IndexIdentity[] } | null {
  const prefixMatch = statement.match(/^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?/i);
  if (!prefixMatch) {
    return null;
  }

  const concurrent = /\bCONCURRENTLY\b/i.test(prefixMatch[0]);
  const indexes: IndexIdentity[] = [];
  const targets = statement
    .slice(prefixMatch[0].length)
    .split(",")
    .map((entry) => trimDropQualifier(entry))
    .filter((entry) => entry.length > 0);

  for (const target of targets) {
    const parsed = parseQualifiedIdentifier(target);
    if (!parsed) {
      continue;
    }
    indexes.push(toQualifiedIndex(parsed, defaultSchema));
  }

  return {
    concurrent,
    indexes,
  };
}

function buildTableRowCountIndex(snapshot: SchemaSnapshot): Map<string, number> {
  const index = new Map<string, number>();
  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      index.set(tableKey(schema.name, table.name), sanitizeNumber(table.rowCount));
    }
  }
  return index;
}

function lookupRowCount(
  rowCountByTable: Map<string, number>,
  schemaName: string,
  tableName: string
): number {
  return rowCountByTable.get(tableKey(schemaName, tableName)) ?? 0;
}

function parseQualifiedTableName(value: string): TableRef | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }
  return {
    schemaName: normalizeIdentifier(trimmed.slice(0, separatorIndex)),
    tableName: normalizeIdentifier(trimmed.slice(separatorIndex + 1)),
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

function skipWhitespace(input: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < input.length && /\s/.test(input[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function toQualifiedIndex(parts: string[], defaultSchema: string): IndexIdentity {
  if (parts.length === 1) {
    return {
      schemaName: normalizeIdentifier(defaultSchema),
      name: normalizeIdentifier(parts[0]),
    };
  }
  return {
    schemaName: normalizeIdentifier(parts[0]),
    name: normalizeIdentifier(parts[1]),
  };
}

function toTableRef(parts: string[], defaultSchema: string): TableRef {
  if (parts.length === 1) {
    return {
      schemaName: normalizeIdentifier(defaultSchema),
      tableName: normalizeIdentifier(parts[0]),
    };
  }
  return {
    schemaName: normalizeIdentifier(parts[0]),
    tableName: normalizeIdentifier(parts[1]),
  };
}

function tableKey(schemaName: string, tableName: string): string {
  return `${normalizeIdentifier(schemaName)}.${normalizeIdentifier(tableName)}`;
}

function tableIndexKey(schemaName: string, tableName: string, indexName: string): string {
  return `${tableKey(schemaName, tableName)}.${normalizeIdentifier(indexName)}`;
}

function indexKey(schemaName: string, indexName: string): string {
  return `${normalizeIdentifier(schemaName)}.${normalizeIdentifier(indexName)}`;
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function normalizeDataType(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeOptional(value: string | null): string {
  return normalizeWhitespace(value ?? "").toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sanitizeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function trimDropQualifier(value: string): string {
  return value
    .trim()
    .replace(/\s+(?:CASCADE|RESTRICT)\b/gi, "")
    .trim();
}

function hasNonEmptyValue(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
