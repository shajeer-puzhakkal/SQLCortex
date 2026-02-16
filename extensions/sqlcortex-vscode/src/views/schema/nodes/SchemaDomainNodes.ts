import * as vscode from "vscode";
import { SchemaTreeNode } from "./SchemaTreeNode";

export type SchemaTreeSchema = {
  name: string;
  tables: SchemaTreeTable[];
  views: SchemaTreeView[];
  functions: SchemaTreeRoutine[];
  procedures: SchemaTreeRoutine[];
};

export type SchemaTreeTable = {
  name: string;
  columns: SchemaTreeColumn[];
  constraints: SchemaTreeConstraint[];
  foreignKeys: SchemaTreeForeignKey[];
  indexes: SchemaTreeIndex[];
};

export type SchemaTreeColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
};

export type SchemaTreeConstraint = {
  name: string;
  type: string;
  columns: string[];
  definition: string | null;
};

export type SchemaTreeForeignKey = {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};

export type SchemaTreeIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
  predicate: string | null;
};

export type SchemaTreeView = {
  name: string;
  definition: string | null;
};

export type SchemaTreeRoutine = {
  name: string;
  kind?: string | null;
  signature: string | null;
  returnType: string | null;
  language: string | null;
};

export function buildSchemaNode(schema: SchemaTreeSchema): SchemaTreeNode {
  const schemaId = `dbcopilot.schema.${toNodeId(schema.name)}`;
  const tables = [...schema.tables].sort((left, right) => left.name.localeCompare(right.name));
  const views = [...schema.views].sort((left, right) => left.name.localeCompare(right.name));
  const functions = [...schema.functions].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const procedures = [...schema.procedures].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  return new SchemaTreeNode(schema.name, {
    icon: "symbol-namespace",
    contextValue: "dbcopilot.schema",
    id: schemaId,
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    children: [
      createCategoryNode(
        `${schemaId}.tables`,
        "Tables",
        "table",
        tables.map((table) => buildTableNode(schema.name, table))
      ),
      createCategoryNode(
        `${schemaId}.views`,
        "Views",
        "symbol-interface",
        views.map((view) => buildViewNode(schema.name, view))
      ),
      createCategoryNode(
        `${schemaId}.functions`,
        "Functions",
        "symbol-function",
        functions.map((routine) => buildRoutineNode(schema.name, routine, "function"))
      ),
      createCategoryNode(
        `${schemaId}.procedures`,
        "Procedures",
        "symbol-method",
        procedures.map((routine) => buildRoutineNode(schema.name, routine, "procedure"))
      ),
    ],
  });
}

function buildTableNode(schemaName: string, table: SchemaTreeTable): SchemaTreeNode {
  const tableId = `dbcopilot.schema.${toNodeId(schemaName)}.table.${toNodeId(table.name)}`;
  const sortedColumns = [...table.columns].sort((left, right) => left.name.localeCompare(right.name));
  const sortedConstraints = [...table.constraints].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const sortedForeignKeys = [...table.foreignKeys].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const sortedIndexes = [...table.indexes].sort((left, right) => left.name.localeCompare(right.name));

  return new SchemaTreeNode(table.name, {
    icon: "table",
    contextValue: "dbcopilot.schema.table",
    id: tableId,
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    children: [
      createCategoryNode(
        `${tableId}.columns`,
        "Columns",
        "symbol-field",
        sortedColumns.map((column) => buildColumnNode(tableId, column))
      ),
      createCategoryNode(
        `${tableId}.constraints`,
        "Constraints",
        "lock",
        sortedConstraints.map((constraint) => buildConstraintNode(tableId, constraint))
      ),
      createCategoryNode(
        `${tableId}.relationships`,
        "Relationships",
        "references",
        sortedForeignKeys.map((foreignKey) => buildForeignKeyNode(tableId, foreignKey))
      ),
      createCategoryNode(
        `${tableId}.indexes`,
        "Indexes",
        "list-tree",
        sortedIndexes.map((index) => buildIndexNode(tableId, index))
      ),
    ],
  });
}

function buildColumnNode(tableId: string, column: SchemaTreeColumn): SchemaTreeNode {
  const nullable = column.nullable ? "nullable" : "not null";
  const defaultValue = column.defaultValue ? ` default ${column.defaultValue}` : "";

  return new SchemaTreeNode(column.name, {
    icon: "symbol-field",
    id: `${tableId}.column.${toNodeId(column.name)}`,
    contextValue: "dbcopilot.schema.column",
    description: `${column.dataType} ${nullable}${defaultValue}`,
  });
}

function buildConstraintNode(
  tableId: string,
  constraint: SchemaTreeConstraint
): SchemaTreeNode {
  const columns = constraint.columns.length ? `(${constraint.columns.join(", ")})` : "";
  const detail = [constraint.type, columns].filter((value) => value.trim().length > 0).join(" ");
  const tooltip = constraint.definition ?? (detail || constraint.name);

  return new SchemaTreeNode(constraint.name, {
    icon: "lock",
    id: `${tableId}.constraint.${toNodeId(constraint.name)}`,
    contextValue: "dbcopilot.schema.constraint",
    description: detail || undefined,
    tooltip,
  });
}

function buildForeignKeyNode(
  tableId: string,
  foreignKey: SchemaTreeForeignKey
): SchemaTreeNode {
  const sourceColumns = foreignKey.columns.join(", ");
  const destinationColumns = foreignKey.referencedColumns.join(", ");
  const destination = `${foreignKey.referencedSchema}.${foreignKey.referencedTable}`;
  const actionParts = [
    foreignKey.onUpdate ? `on update ${foreignKey.onUpdate}` : null,
    foreignKey.onDelete ? `on delete ${foreignKey.onDelete}` : null,
  ].filter((value): value is string => Boolean(value));

  const description = `${sourceColumns} -> ${destination}(${destinationColumns})`;
  const tooltip = actionParts.length
    ? `${description} (${actionParts.join(", ")})`
    : description;

  return new SchemaTreeNode(foreignKey.name, {
    icon: "references",
    id: `${tableId}.fk.${toNodeId(foreignKey.name)}`,
    contextValue: "dbcopilot.schema.relationship",
    description,
    tooltip,
  });
}

function buildIndexNode(tableId: string, index: SchemaTreeIndex): SchemaTreeNode {
  const tags: string[] = [];
  if (index.primary) {
    tags.push("primary");
  }
  if (index.unique) {
    tags.push("unique");
  }
  if (index.method) {
    tags.push(index.method);
  }
  const columns = index.columns.length ? `(${index.columns.join(", ")})` : "";
  const tagText = tags.length ? `[${tags.join(", ")}]` : "";
  const description = [tagText, columns].filter((value) => value.length > 0).join(" ");

  return new SchemaTreeNode(index.name, {
    icon: "list-tree",
    id: `${tableId}.index.${toNodeId(index.name)}`,
    contextValue: "dbcopilot.schema.index",
    description: description || undefined,
    tooltip: index.predicate ? `${description} where ${index.predicate}` : description || index.name,
  });
}

function buildViewNode(schemaName: string, view: SchemaTreeView): SchemaTreeNode {
  const id = `dbcopilot.schema.${toNodeId(schemaName)}.view.${toNodeId(view.name)}`;
  return new SchemaTreeNode(view.name, {
    icon: "symbol-interface",
    id,
    contextValue: "dbcopilot.schema.view",
    tooltip: view.definition ?? view.name,
  });
}

function buildRoutineNode(
  schemaName: string,
  routine: SchemaTreeRoutine,
  kind: "function" | "procedure"
): SchemaTreeNode {
  const id = `dbcopilot.schema.${toNodeId(schemaName)}.${kind}.${toNodeId(routine.name)}`;
  const descriptionParts = [routine.signature ?? null, routine.returnType ?? null, routine.language ?? null]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return new SchemaTreeNode(routine.name, {
    icon: kind === "function" ? "symbol-function" : "symbol-method",
    id,
    contextValue: `dbcopilot.schema.${kind}`,
    description: descriptionParts.join(" | ") || undefined,
  });
}

function createCategoryNode(
  id: string,
  label: string,
  icon: string,
  items: SchemaTreeNode[]
): SchemaTreeNode {
  if (items.length === 0) {
    return new SchemaTreeNode(label, {
      icon,
      id,
      description: "0",
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: [
        new SchemaTreeNode(`No ${label.toLowerCase()}`, {
          icon: "circle-slash",
          id: `${id}.empty`,
        }),
      ],
    });
  }

  return new SchemaTreeNode(label, {
    icon,
    id,
    description: String(items.length),
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    children: items,
  });
}

function toNodeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}
