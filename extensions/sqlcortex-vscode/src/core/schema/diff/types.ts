import type {
  SchemaSnapshot,
  SchemaSnapshotColumn,
  SchemaSnapshotForeignKey,
  SchemaSnapshotIndex,
  SchemaSnapshotTable,
} from "../SchemaTypes";

export type SchemaDiffKind = "added" | "removed" | "changed";

export type SchemaSnapshotDiff = {
  previousCapturedAt: string | null;
  nextCapturedAt: string | null;
  tableChanges: SchemaSnapshotTableDiff[];
  columnChanges: SchemaSnapshotColumnDiff[];
  indexChanges: SchemaSnapshotIndexDiff[];
  foreignKeyChanges: SchemaSnapshotForeignKeyDiff[];
  hasChanges: boolean;
};

export type SchemaSnapshotTableDiff = {
  kind: SchemaDiffKind;
  schemaName: string;
  tableName: string;
  previous: SchemaSnapshotTable | null;
  next: SchemaSnapshotTable | null;
};

export type SchemaSnapshotColumnDiff = {
  kind: SchemaDiffKind;
  schemaName: string;
  tableName: string;
  columnName: string;
  previous: SchemaSnapshotColumn | null;
  next: SchemaSnapshotColumn | null;
};

export type SchemaSnapshotIndexDiff = {
  kind: SchemaDiffKind;
  schemaName: string;
  tableName: string;
  indexName: string;
  previous: SchemaSnapshotIndex | null;
  next: SchemaSnapshotIndex | null;
};

export type SchemaSnapshotForeignKeyDiff = {
  kind: SchemaDiffKind;
  schemaName: string;
  tableName: string;
  foreignKeyName: string;
  previous: SchemaSnapshotForeignKey | null;
  next: SchemaSnapshotForeignKey | null;
};

export type SchemaSnapshotLike = SchemaSnapshot | null | undefined;
