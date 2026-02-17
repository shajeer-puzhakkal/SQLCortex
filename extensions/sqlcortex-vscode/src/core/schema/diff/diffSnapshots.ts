import { toSchemaGraphTableId } from "../SchemaGraph";
import type {
  SchemaSnapshot,
  SchemaSnapshotColumn,
  SchemaSnapshotConstraint,
  SchemaSnapshotForeignKey,
  SchemaSnapshotIndex,
  SchemaSnapshotTable,
} from "../SchemaTypes";
import type {
  SchemaSnapshotColumnDiff,
  SchemaSnapshotDiff,
  SchemaSnapshotForeignKeyDiff,
  SchemaSnapshotIndexDiff,
  SchemaSnapshotLike,
  SchemaSnapshotTableDiff,
} from "./types";

type TableEntry = {
  schemaName: string;
  tableName: string;
  table: SchemaSnapshotTable;
};

export function diffSnapshots(
  previousSnapshot: SchemaSnapshotLike,
  nextSnapshot: SchemaSnapshotLike
): SchemaSnapshotDiff {
  const previous = previousSnapshot ?? emptySnapshot();
  const next = nextSnapshot ?? emptySnapshot();

  const previousTables = collectTables(previous);
  const nextTables = collectTables(next);
  const allTableIds = collectUnionKeys(previousTables, nextTables);

  const tableChanges: SchemaSnapshotTableDiff[] = [];
  const columnChanges: SchemaSnapshotColumnDiff[] = [];
  const indexChanges: SchemaSnapshotIndexDiff[] = [];
  const foreignKeyChanges: SchemaSnapshotForeignKeyDiff[] = [];

  for (const tableId of allTableIds) {
    const previousEntry = previousTables.get(tableId) ?? null;
    const nextEntry = nextTables.get(tableId) ?? null;

    if (!previousEntry && !nextEntry) {
      continue;
    }

    if (!previousEntry && nextEntry) {
      tableChanges.push(createTableChange("added", nextEntry, null, nextEntry.table));
      pushAllColumnChanges("added", nextEntry, null, nextEntry.table, columnChanges);
      pushAllIndexChanges("added", nextEntry, null, nextEntry.table, indexChanges);
      pushAllForeignKeyChanges("added", nextEntry, null, nextEntry.table, foreignKeyChanges);
      continue;
    }

    if (previousEntry && !nextEntry) {
      tableChanges.push(createTableChange("removed", previousEntry, previousEntry.table, null));
      pushAllColumnChanges("removed", previousEntry, previousEntry.table, null, columnChanges);
      pushAllIndexChanges("removed", previousEntry, previousEntry.table, null, indexChanges);
      pushAllForeignKeyChanges("removed", previousEntry, previousEntry.table, null, foreignKeyChanges);
      continue;
    }

    if (!previousEntry || !nextEntry) {
      continue;
    }

    if (!areConstraintSetsEqual(previousEntry.table.constraints, nextEntry.table.constraints)) {
      tableChanges.push(
        createTableChange("changed", nextEntry, previousEntry.table, nextEntry.table)
      );
    }

    pushColumnDiffs(previousEntry, nextEntry, columnChanges);
    pushIndexDiffs(previousEntry, nextEntry, indexChanges);
    pushForeignKeyDiffs(previousEntry, nextEntry, foreignKeyChanges);
  }

  tableChanges.sort(compareTableChanges);
  columnChanges.sort(compareColumnChanges);
  indexChanges.sort(compareIndexChanges);
  foreignKeyChanges.sort(compareForeignKeyChanges);

  return {
    previousCapturedAt: previous.capturedAt ?? null,
    nextCapturedAt: next.capturedAt ?? null,
    tableChanges,
    columnChanges,
    indexChanges,
    foreignKeyChanges,
    hasChanges:
      tableChanges.length > 0 ||
      columnChanges.length > 0 ||
      indexChanges.length > 0 ||
      foreignKeyChanges.length > 0,
  };
}

function emptySnapshot(): SchemaSnapshot {
  return { schemas: [] };
}

function collectTables(snapshot: SchemaSnapshot): Map<string, TableEntry> {
  const tables = new Map<string, TableEntry>();
  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      tables.set(toSchemaGraphTableId(schema.name, table.name), {
        schemaName: schema.name,
        tableName: table.name,
        table,
      });
    }
  }
  return tables;
}

function collectUnionKeys<T>(
  previous: Map<string, T>,
  next: Map<string, T>
): string[] {
  const keys = new Set<string>();
  for (const key of previous.keys()) {
    keys.add(key);
  }
  for (const key of next.keys()) {
    keys.add(key);
  }
  return Array.from(keys.values()).sort((left, right) => left.localeCompare(right));
}

function createTableChange(
  kind: SchemaSnapshotTableDiff["kind"],
  entry: TableEntry,
  previous: SchemaSnapshotTable | null,
  next: SchemaSnapshotTable | null
): SchemaSnapshotTableDiff {
  return {
    kind,
    schemaName: entry.schemaName,
    tableName: entry.tableName,
    previous,
    next,
  };
}

function pushAllColumnChanges(
  kind: SchemaSnapshotColumnDiff["kind"],
  entry: TableEntry,
  previousTable: SchemaSnapshotTable | null,
  nextTable: SchemaSnapshotTable | null,
  target: SchemaSnapshotColumnDiff[]
): void {
  if (kind === "added" && nextTable) {
    for (const column of nextTable.columns) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        columnName: column.name,
        previous: null,
        next: column,
      });
    }
    return;
  }

  if (kind === "removed" && previousTable) {
    for (const column of previousTable.columns) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        columnName: column.name,
        previous: column,
        next: null,
      });
    }
  }
}

function pushColumnDiffs(
  previousEntry: TableEntry,
  nextEntry: TableEntry,
  target: SchemaSnapshotColumnDiff[]
): void {
  const previousColumns = collectNamed(previousEntry.table.columns, (column) => column.name);
  const nextColumns = collectNamed(nextEntry.table.columns, (column) => column.name);

  for (const key of collectUnionKeys(previousColumns, nextColumns)) {
    const previousColumn = previousColumns.get(key) ?? null;
    const nextColumn = nextColumns.get(key) ?? null;
    const columnName = nextColumn?.name ?? previousColumn?.name ?? key;

    if (!previousColumn && nextColumn) {
      target.push({
        kind: "added",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        columnName,
        previous: null,
        next: nextColumn,
      });
      continue;
    }

    if (previousColumn && !nextColumn) {
      target.push({
        kind: "removed",
        schemaName: previousEntry.schemaName,
        tableName: previousEntry.tableName,
        columnName,
        previous: previousColumn,
        next: null,
      });
      continue;
    }

    if (!previousColumn || !nextColumn) {
      continue;
    }

    if (!areColumnsEqual(previousColumn, nextColumn)) {
      target.push({
        kind: "changed",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        columnName,
        previous: previousColumn,
        next: nextColumn,
      });
    }
  }
}

function pushAllIndexChanges(
  kind: SchemaSnapshotIndexDiff["kind"],
  entry: TableEntry,
  previousTable: SchemaSnapshotTable | null,
  nextTable: SchemaSnapshotTable | null,
  target: SchemaSnapshotIndexDiff[]
): void {
  if (kind === "added" && nextTable) {
    for (const index of nextTable.indexes) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        indexName: index.name,
        previous: null,
        next: index,
      });
    }
    return;
  }

  if (kind === "removed" && previousTable) {
    for (const index of previousTable.indexes) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        indexName: index.name,
        previous: index,
        next: null,
      });
    }
  }
}

function pushIndexDiffs(
  previousEntry: TableEntry,
  nextEntry: TableEntry,
  target: SchemaSnapshotIndexDiff[]
): void {
  const previousIndexes = collectNamed(previousEntry.table.indexes, (index) => index.name);
  const nextIndexes = collectNamed(nextEntry.table.indexes, (index) => index.name);

  for (const key of collectUnionKeys(previousIndexes, nextIndexes)) {
    const previousIndex = previousIndexes.get(key) ?? null;
    const nextIndex = nextIndexes.get(key) ?? null;
    const indexName = nextIndex?.name ?? previousIndex?.name ?? key;

    if (!previousIndex && nextIndex) {
      target.push({
        kind: "added",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        indexName,
        previous: null,
        next: nextIndex,
      });
      continue;
    }

    if (previousIndex && !nextIndex) {
      target.push({
        kind: "removed",
        schemaName: previousEntry.schemaName,
        tableName: previousEntry.tableName,
        indexName,
        previous: previousIndex,
        next: null,
      });
      continue;
    }

    if (!previousIndex || !nextIndex) {
      continue;
    }

    if (!areIndexesEqual(previousIndex, nextIndex)) {
      target.push({
        kind: "changed",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        indexName,
        previous: previousIndex,
        next: nextIndex,
      });
    }
  }
}

function pushAllForeignKeyChanges(
  kind: SchemaSnapshotForeignKeyDiff["kind"],
  entry: TableEntry,
  previousTable: SchemaSnapshotTable | null,
  nextTable: SchemaSnapshotTable | null,
  target: SchemaSnapshotForeignKeyDiff[]
): void {
  if (kind === "added" && nextTable) {
    for (const foreignKey of nextTable.foreignKeys) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        foreignKeyName: foreignKey.name,
        previous: null,
        next: foreignKey,
      });
    }
    return;
  }

  if (kind === "removed" && previousTable) {
    for (const foreignKey of previousTable.foreignKeys) {
      target.push({
        kind,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        foreignKeyName: foreignKey.name,
        previous: foreignKey,
        next: null,
      });
    }
  }
}

function pushForeignKeyDiffs(
  previousEntry: TableEntry,
  nextEntry: TableEntry,
  target: SchemaSnapshotForeignKeyDiff[]
): void {
  const previousForeignKeys = collectNamed(previousEntry.table.foreignKeys, (foreignKey) => foreignKey.name);
  const nextForeignKeys = collectNamed(nextEntry.table.foreignKeys, (foreignKey) => foreignKey.name);

  for (const key of collectUnionKeys(previousForeignKeys, nextForeignKeys)) {
    const previousForeignKey = previousForeignKeys.get(key) ?? null;
    const nextForeignKey = nextForeignKeys.get(key) ?? null;
    const foreignKeyName = nextForeignKey?.name ?? previousForeignKey?.name ?? key;

    if (!previousForeignKey && nextForeignKey) {
      target.push({
        kind: "added",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        foreignKeyName,
        previous: null,
        next: nextForeignKey,
      });
      continue;
    }

    if (previousForeignKey && !nextForeignKey) {
      target.push({
        kind: "removed",
        schemaName: previousEntry.schemaName,
        tableName: previousEntry.tableName,
        foreignKeyName,
        previous: previousForeignKey,
        next: null,
      });
      continue;
    }

    if (!previousForeignKey || !nextForeignKey) {
      continue;
    }

    if (!areForeignKeysEqual(previousForeignKey, nextForeignKey)) {
      target.push({
        kind: "changed",
        schemaName: nextEntry.schemaName,
        tableName: nextEntry.tableName,
        foreignKeyName,
        previous: previousForeignKey,
        next: nextForeignKey,
      });
    }
  }
}

function collectNamed<T>(items: T[], getName: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  const collisions = new Map<string, number>();

  for (const item of items) {
    const baseName = getName(item).trim();
    const collisionCount = (collisions.get(baseName) ?? 0) + 1;
    collisions.set(baseName, collisionCount);
    const key = collisionCount === 1 ? baseName : `${baseName}#${collisionCount}`;
    map.set(key, item);
  }

  return map;
}

function areColumnsEqual(previous: SchemaSnapshotColumn, next: SchemaSnapshotColumn): boolean {
  return (
    previous.name === next.name &&
    normalizeType(previous.dataType) === normalizeType(next.dataType) &&
    previous.nullable === next.nullable &&
    normalizeOptional(previous.default) === normalizeOptional(next.default)
  );
}

function areIndexesEqual(previous: SchemaSnapshotIndex, next: SchemaSnapshotIndex): boolean {
  return (
    previous.name === next.name &&
    previous.unique === next.unique &&
    previous.primary === next.primary &&
    normalizeType(previous.method) === normalizeType(next.method) &&
    normalizeOptional(previous.predicate) === normalizeOptional(next.predicate) &&
    areStringArraysEqual(previous.columns, next.columns)
  );
}

function areForeignKeysEqual(
  previous: SchemaSnapshotForeignKey,
  next: SchemaSnapshotForeignKey
): boolean {
  return (
    previous.name === next.name &&
    previous.referencedSchema === next.referencedSchema &&
    previous.referencedTable === next.referencedTable &&
    normalizeType(previous.onUpdate) === normalizeType(next.onUpdate) &&
    normalizeType(previous.onDelete) === normalizeType(next.onDelete) &&
    areStringArraysEqual(previous.columns, next.columns) &&
    areStringArraysEqual(previous.referencedColumns, next.referencedColumns)
  );
}

function areConstraintSetsEqual(
  previous: SchemaSnapshotConstraint[],
  next: SchemaSnapshotConstraint[]
): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  const previousEntries = previous
    .map((constraint) => serializeConstraint(constraint))
    .sort((left, right) => left.localeCompare(right));
  const nextEntries = next
    .map((constraint) => serializeConstraint(constraint))
    .sort((left, right) => left.localeCompare(right));

  return areStringArraysEqual(previousEntries, nextEntries);
}

function serializeConstraint(constraint: SchemaSnapshotConstraint): string {
  return [
    constraint.name,
    constraint.type,
    normalizeOptional(constraint.definition),
    constraint.columns.join("|"),
  ].join("::");
}

function areStringArraysEqual(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }

  return true;
}

function normalizeType(value: string | null): string {
  return normalizeOptional(value).toLowerCase();
}

function normalizeOptional(value: string | null): string {
  if (!value) {
    return "";
  }
  return value.trim().replace(/\s+/g, " ");
}

type ScopedChange = {
  kind: SchemaSnapshotTableDiff["kind"];
  schemaName: string;
  tableName: string;
};

function compareKinds(left: SchemaSnapshotTableDiff["kind"], right: SchemaSnapshotTableDiff["kind"]): number {
  return rankKind(left) - rankKind(right);
}

function rankKind(kind: SchemaSnapshotTableDiff["kind"]): number {
  switch (kind) {
    case "added":
      return 0;
    case "removed":
      return 1;
    default:
      return 2;
  }
}

function compareTableChanges(left: SchemaSnapshotTableDiff, right: SchemaSnapshotTableDiff): number {
  return compareScopedChanges(left, right);
}

function compareScopedChanges(left: ScopedChange, right: ScopedChange): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  const tableCompare = left.tableName.localeCompare(right.tableName);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  return compareKinds(left.kind, right.kind);
}

function compareColumnChanges(left: SchemaSnapshotColumnDiff, right: SchemaSnapshotColumnDiff): number {
  const tableCompare = compareScopedChanges(left, right);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  const columnCompare = left.columnName.localeCompare(right.columnName);
  if (columnCompare !== 0) {
    return columnCompare;
  }
  return compareKinds(left.kind, right.kind);
}

function compareIndexChanges(left: SchemaSnapshotIndexDiff, right: SchemaSnapshotIndexDiff): number {
  const tableCompare = compareScopedChanges(left, right);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  const indexCompare = left.indexName.localeCompare(right.indexName);
  if (indexCompare !== 0) {
    return indexCompare;
  }
  return compareKinds(left.kind, right.kind);
}

function compareForeignKeyChanges(
  left: SchemaSnapshotForeignKeyDiff,
  right: SchemaSnapshotForeignKeyDiff
): number {
  const tableCompare = compareScopedChanges(left, right);
  if (tableCompare !== 0) {
    return tableCompare;
  }
  const foreignKeyCompare = left.foreignKeyName.localeCompare(right.foreignKeyName);
  if (foreignKeyCompare !== 0) {
    return foreignKeyCompare;
  }
  return compareKinds(left.kind, right.kind);
}
