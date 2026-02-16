import type {
  SchemaSnapshotColumn,
  SchemaSnapshotConstraint,
  SchemaSnapshotForeignKey,
  SchemaSnapshotIndex,
} from "./SchemaTypes";

export type SchemaGraphTableId = string;

export type SchemaGraphTableRef = {
  schemaName: string;
  tableName: string;
  id: SchemaGraphTableId;
};

export type SchemaGraphForeignKeyEdge = {
  id: string;
  name: string;
  source: SchemaGraphTableRef;
  target: SchemaGraphTableRef;
  columns: string[];
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};

export type SchemaGraphTableNode = {
  ref: SchemaGraphTableRef;
  columns: SchemaSnapshotColumn[];
  constraints: SchemaSnapshotConstraint[];
  indexes: SchemaSnapshotIndex[];
  foreignKeys: SchemaSnapshotForeignKey[];
  outgoingForeignKeys: SchemaGraphForeignKeyEdge[];
  incomingForeignKeys: SchemaGraphForeignKeyEdge[];
  dependencies: SchemaGraphTableRef[];
  dependents: SchemaGraphTableRef[];
};

export type SchemaGraph = {
  capturedAt: string | undefined;
  tables: Record<SchemaGraphTableId, SchemaGraphTableNode>;
  tableIds: SchemaGraphTableId[];
  foreignKeys: SchemaGraphForeignKeyEdge[];
  outgoingForeignKeysByTable: Record<SchemaGraphTableId, SchemaGraphForeignKeyEdge[]>;
  incomingForeignKeysByTable: Record<SchemaGraphTableId, SchemaGraphForeignKeyEdge[]>;
};

export function createSchemaGraphTableRef(
  schemaName: string,
  tableName: string
): SchemaGraphTableRef {
  const normalizedSchemaName = schemaName.trim();
  const normalizedTableName = tableName.trim();
  return {
    schemaName: normalizedSchemaName,
    tableName: normalizedTableName,
    id: toSchemaGraphTableId(normalizedSchemaName, normalizedTableName),
  };
}

export function toSchemaGraphTableId(schemaName: string, tableName: string): SchemaGraphTableId {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
