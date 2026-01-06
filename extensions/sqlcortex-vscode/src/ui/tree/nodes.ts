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
  | TableNode
  | ColumnsRootNode
  | ColumnNode
  | ErrorNode
  | LoadingNode;

type NodeKind =
  | "action"
  | "connection"
  | "schemasRoot"
  | "schema"
  | "table"
  | "columnsRoot"
  | "column"
  | "error"
  | "loading";

abstract class BaseNode extends vscode.TreeItem {
  readonly kind: NodeKind;
  readonly parent?: DbExplorerNode;

  protected constructor(
    kind: NodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    parent?: DbExplorerNode
  ) {
    super(label, collapsibleState);
    this.kind = kind;
    this.parent = parent;
  }
}

export class ActionNode extends BaseNode {
  constructor(label: string, commandId: string, parent?: DbExplorerNode) {
    super("action", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.action";
    this.command = { command: commandId, title: label };
  }
}

export class ConnectionNode extends BaseNode {
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

export class SchemasRootNode extends BaseNode {
  readonly connectionId: string;

  constructor(connectionId: string, parent?: DbExplorerNode) {
    super("schemasRoot", "Schemas", vscode.TreeItemCollapsibleState.Collapsed, parent);
    this.connectionId = connectionId;
    this.id = `sqlcortex.schemasRoot.${connectionId}`;
    this.contextValue = "sqlcortex.schemasRoot";
    this.iconPath = new vscode.ThemeIcon("symbol-namespace");
  }
}

export class SchemaNode extends BaseNode {
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

export class TableNode extends BaseNode {
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

export class ColumnsRootNode extends BaseNode {
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

export class ColumnNode extends BaseNode {
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

export class ErrorNode extends BaseNode {
  constructor(label: string, commandId: string, parent?: DbExplorerNode) {
    super("error", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.error";
    this.command = { command: commandId, title: "Retry" };
    this.iconPath = new vscode.ThemeIcon("error");
  }
}

export class LoadingNode extends BaseNode {
  constructor(label = "Loading...", parent?: DbExplorerNode) {
    super("loading", label, vscode.TreeItemCollapsibleState.None, parent);
    this.contextValue = "sqlcortex.loading";
    this.iconPath = new vscode.ThemeIcon("sync~spin");
  }
}
