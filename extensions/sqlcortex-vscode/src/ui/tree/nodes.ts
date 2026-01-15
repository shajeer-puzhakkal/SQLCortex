import * as vscode from "vscode";
import type {
  ConnectionResource,
  SchemaColumnResource,
  SchemaTableResource,
} from "../../api/types";

export type DbExplorerNode =
  | ActionNode
  | ConnectionNode
  | SchemasRootNode
  | SchemaNode
  | SchemaSectionNode
  | TableNode
  | ColumnsRootNode
  | ConstraintsRootNode
  | ColumnNode
  | ConstraintNode
  | InfoNode
  | ErrorNode
  | LoadingNode;

export type SchemaSectionType = "tables" | "views" | "functions";

type NodeKind =
  | "action"
  | "connection"
  | "schemasRoot"
  | "schema"
  | "schemaSection"
  | "table"
  | "columnsRoot"
  | "constraintsRoot"
  | "column"
  | "constraint"
  | "info"
  | "error"
  | "loading";

abstract class BaseNode<K extends NodeKind> extends vscode.TreeItem {
  readonly kind: K;
  readonly parent?: DbExplorerNode;

  protected constructor(
    kind: K,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    parent?: DbExplorerNode
  ) {
    super(label, collapsibleState);
    this.kind = kind;
    this.parent = parent;
  }
}

export class ActionNode extends BaseNode<"action"> {
  constructor(label: string, commandId: string, parent?: DbExplorerNode) {
    super("action", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.action";
    this.command = { command: commandId, title: label };
  }
}

export class ConnectionNode extends BaseNode<"connection"> {
  readonly connection: ConnectionResource;

  constructor(connection: ConnectionResource, parent?: DbExplorerNode) {
    super("connection", connection.name, vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connection = connection;
    this.id = `sqlcortex.connection.${connection.id}`;
    this.contextValue = "sqlcortex.connection";
    this.description = connection.id;
    this.tooltip = `${connection.name}\n${connection.type}`;
    this.iconPath = new vscode.ThemeIcon("database");
  }
}

export class SchemasRootNode extends BaseNode<"schemasRoot"> {
  readonly connectionId: string;

  constructor(connectionId: string, parent?: DbExplorerNode) {
    super("schemasRoot", "Schemas", vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.id = `sqlcortex.schemasRoot.${connectionId}`;
    this.contextValue = "sqlcortex.schemasRoot";
    this.iconPath = new vscode.ThemeIcon("symbol-namespace");
  }
}

export class SchemaNode extends BaseNode<"schema"> {
  readonly connectionId: string;
  readonly schemaName: string;

  constructor(connectionId: string, schemaName: string, parent?: DbExplorerNode) {
    super("schema", schemaName, vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.id = `sqlcortex.schema.${connectionId}.${schemaName}`;
    this.contextValue = "sqlcortex.schema";
    this.iconPath = new vscode.ThemeIcon("symbol-namespace");
  }
}

export class SchemaSectionNode extends BaseNode<"schemaSection"> {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly sectionType: SchemaSectionType;

  constructor(
    connectionId: string,
    schemaName: string,
    sectionType: SchemaSectionType,
    parent?: DbExplorerNode
  ) {
    const label =
      sectionType === "tables"
        ? "Tables"
        : sectionType === "views"
          ? "Views"
          : "Functions";
    super("schemaSection", label, vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.sectionType = sectionType;
    this.id = `sqlcortex.schemaSection.${connectionId}.${schemaName}.${sectionType}`;
    this.contextValue = "sqlcortex.schemaSection";
    const icon =
      sectionType === "tables"
        ? "table"
        : sectionType === "views"
          ? "eye"
          : "symbol-function";
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class TableNode extends BaseNode<"table"> {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly table: SchemaTableResource;

  constructor(
    connectionId: string,
    schemaName: string,
    table: SchemaTableResource,
    parent?: DbExplorerNode
  ) {
    super("table", table.name, vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.table = table;
    this.id = `sqlcortex.table.${connectionId}.${schemaName}.${table.name}`;
    this.contextValue = "sqlcortex.table";
    this.description = table.type === "view" ? "view" : undefined;
    this.iconPath = new vscode.ThemeIcon(table.type === "view" ? "symbol-class" : "table");
  }
}

export class ColumnsRootNode extends BaseNode<"columnsRoot"> {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly tableName: string;

  constructor(
    connectionId: string,
    schemaName: string,
    tableName: string,
    parent?: DbExplorerNode
  ) {
    super("columnsRoot", "Columns", vscode.TreeItemCollapsibleState.Expanded, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.tableName = tableName;
    this.id = `sqlcortex.columnsRoot.${connectionId}.${schemaName}.${tableName}`;
    this.contextValue = "sqlcortex.columnsRoot";
    this.iconPath = new vscode.ThemeIcon("symbol-field");
  }
}

export class ConstraintsRootNode extends BaseNode<"constraintsRoot"> {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly tableName: string;

  constructor(
    connectionId: string,
    schemaName: string,
    tableName: string,
    parent?: DbExplorerNode
  ) {
    super("constraintsRoot", "Constraints", vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.tableName = tableName;
    this.id = `sqlcortex.constraintsRoot.${connectionId}.${schemaName}.${tableName}`;
    this.contextValue = "sqlcortex.constraintsRoot";
    this.iconPath = new vscode.ThemeIcon("key");
  }
}

export class ColumnNode extends BaseNode<"column"> {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly column: SchemaColumnResource;

  constructor(
    connectionId: string,
    schemaName: string,
    tableName: string,
    column: SchemaColumnResource,
    parent?: DbExplorerNode
  ) {
    super("column", column.name, vscode.TreeItemCollapsibleState.None, parent);
    this.connectionId = connectionId;
    this.schemaName = schemaName;
    this.tableName = tableName;
    this.column = column;
    this.id = `sqlcortex.column.${connectionId}.${schemaName}.${tableName}.${column.name}`;
    this.contextValue = "sqlcortex.column";
    this.description = column.type;
    this.iconPath = new vscode.ThemeIcon("symbol-field");
  }
}

type ConstraintInfo = {
  name: string;
  type: string;
  summary?: string;
  tooltip?: string;
  icon?: string;
};

export class ConstraintNode extends BaseNode<"constraint"> {
  readonly constraint: ConstraintInfo;

  constructor(constraint: ConstraintInfo, parent?: DbExplorerNode) {
    super("constraint", constraint.name, vscode.TreeItemCollapsibleState.None, parent);
    this.constraint = constraint;
    this.contextValue = "sqlcortex.constraint";
    this.description = constraint.summary;
    this.tooltip = constraint.tooltip ?? constraint.summary ?? constraint.type;
    if (constraint.icon) {
      this.iconPath = new vscode.ThemeIcon(constraint.icon);
    }
  }
}

export class InfoNode extends BaseNode<"info"> {
  constructor(label: string, parent?: DbExplorerNode) {
    super("info", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.info";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class ErrorNode extends BaseNode<"error"> {
  constructor(label: string, commandId: string, parent?: DbExplorerNode) {
    super("error", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.error";
    this.command = { command: commandId, title: "Retry" };
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class LoadingNode extends BaseNode<"loading"> {
  constructor(label = "Loading...", parent?: DbExplorerNode) {
    super("loading", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.loading";
    this.iconPath = new vscode.ThemeIcon("sync~spin");
  }
}
