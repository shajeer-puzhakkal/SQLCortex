import {
  createSchemaGraphTableRef,
  type SchemaGraph,
  type SchemaGraphForeignKeyEdge,
  type SchemaGraphTableId,
  type SchemaGraphTableNode,
  type SchemaGraphTableRef,
} from "./SchemaGraph";
import type { SchemaSnapshot, SchemaSnapshotTable } from "./SchemaTypes";

export function buildSchemaGraph(snapshot: SchemaSnapshot): SchemaGraph {
  const tables: Record<SchemaGraphTableId, SchemaGraphTableNode> = {};
  const tableIds: SchemaGraphTableId[] = [];
  const foreignKeys: SchemaGraphForeignKeyEdge[] = [];
  const outgoingForeignKeysByTable: Record<SchemaGraphTableId, SchemaGraphForeignKeyEdge[]> = {};
  const incomingForeignKeysByTable: Record<SchemaGraphTableId, SchemaGraphForeignKeyEdge[]> = {};
  const foreignKeyEdgeCounter = new Map<string, number>();

  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      const ref = createSchemaGraphTableRef(schema.name, table.name);
      const id = ref.id;
      if (!tables[id]) {
        tableIds.push(id);
      }
      tables[id] = createTableNode(ref, table);
      outgoingForeignKeysByTable[id] = [];
      incomingForeignKeysByTable[id] = [];
    }
  }

  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      const sourceRef = createSchemaGraphTableRef(schema.name, table.name);
      const sourceNode = tables[sourceRef.id];
      if (!sourceNode) {
        continue;
      }

      for (const foreignKey of table.foreignKeys) {
        const targetRef = createSchemaGraphTableRef(
          foreignKey.referencedSchema,
          foreignKey.referencedTable
        );
        const edge = createForeignKeyEdge(
          sourceRef,
          targetRef,
          foreignKey,
          foreignKeyEdgeCounter
        );
        foreignKeys.push(edge);

        ensureEdgeBucket(outgoingForeignKeysByTable, sourceRef.id).push(edge);
        ensureEdgeBucket(incomingForeignKeysByTable, targetRef.id).push(edge);
        sourceNode.outgoingForeignKeys.push(edge);

        const targetNode = tables[targetRef.id];
        if (targetNode) {
          targetNode.incomingForeignKeys.push(edge);
        }
      }
    }
  }

  for (const tableId of tableIds) {
    const node = tables[tableId];
    node.dependencies = collectUniqueTableRefs(node.outgoingForeignKeys.map((edge) => edge.target));
    node.dependents = collectUniqueTableRefs(node.incomingForeignKeys.map((edge) => edge.source));
  }

  return {
    capturedAt: snapshot.capturedAt,
    tables,
    tableIds,
    foreignKeys,
    outgoingForeignKeysByTable,
    incomingForeignKeysByTable,
  };
}

function createTableNode(ref: SchemaGraphTableRef, table: SchemaSnapshotTable): SchemaGraphTableNode {
  return {
    ref,
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
    indexes: table.indexes.map((index) => ({
      name: index.name,
      columns: [...index.columns],
      unique: index.unique,
      primary: index.primary,
      method: index.method,
      predicate: index.predicate,
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
    outgoingForeignKeys: [],
    incomingForeignKeys: [],
    dependencies: [],
    dependents: [],
  };
}

function createForeignKeyEdge(
  source: SchemaGraphTableRef,
  target: SchemaGraphTableRef,
  foreignKey: SchemaSnapshotTable["foreignKeys"][number],
  counter: Map<string, number>
): SchemaGraphForeignKeyEdge {
  const baseId = `${source.id}->${target.id}:${foreignKey.name.trim()}`;
  const index = (counter.get(baseId) ?? 0) + 1;
  counter.set(baseId, index);
  const edgeId = index === 1 ? baseId : `${baseId}#${index}`;

  return {
    id: edgeId,
    name: foreignKey.name,
    source,
    target,
    columns: [...foreignKey.columns],
    referencedColumns: [...foreignKey.referencedColumns],
    onUpdate: foreignKey.onUpdate,
    onDelete: foreignKey.onDelete,
  };
}

function ensureEdgeBucket(
  buckets: Record<SchemaGraphTableId, SchemaGraphForeignKeyEdge[]>,
  tableId: SchemaGraphTableId
): SchemaGraphForeignKeyEdge[] {
  if (!buckets[tableId]) {
    buckets[tableId] = [];
  }
  return buckets[tableId];
}

function collectUniqueTableRefs(refs: SchemaGraphTableRef[]): SchemaGraphTableRef[] {
  const uniqueById = new Map<string, SchemaGraphTableRef>();
  for (const ref of refs) {
    if (!uniqueById.has(ref.id)) {
      uniqueById.set(ref.id, ref);
    }
  }
  return Array.from(uniqueById.values()).sort(compareTableRefs);
}

function compareTableRefs(left: SchemaGraphTableRef, right: SchemaGraphTableRef): number {
  const schemaCompare = left.schemaName.localeCompare(right.schemaName);
  if (schemaCompare !== 0) {
    return schemaCompare;
  }
  return left.tableName.localeCompare(right.tableName);
}
