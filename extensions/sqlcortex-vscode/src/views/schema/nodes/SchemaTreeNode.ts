import * as vscode from "vscode";

export type SchemaTreeResource = {
  schemaName: string;
  objectName: string;
  kind: "table" | "view" | "function" | "procedure";
  definition?: string | null;
  signature?: string | null;
  returnType?: string | null;
  language?: string | null;
};

type SchemaTreeNodeOptions = {
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: SchemaTreeNode[];
  description?: string;
  tooltip?: string;
  icon?: string;
  commandId?: string;
  commandArgs?: unknown[];
  contextValue?: string;
  id?: string;
  resource?: SchemaTreeResource;
};

export class SchemaTreeNode extends vscode.TreeItem {
  readonly children: SchemaTreeNode[];
  readonly resource: SchemaTreeResource | null;

  constructor(label: string, options?: SchemaTreeNodeOptions) {
    super(label, options?.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.children = options?.children ?? [];
    this.resource = options?.resource ?? null;
    this.description = options?.description;
    this.tooltip = options?.tooltip ?? label;
    this.contextValue = options?.contextValue;
    if (options?.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
    if (options?.commandId) {
      this.command = {
        command: options.commandId,
        title: label,
        arguments: options.commandArgs,
      };
    }
    if (options?.id) {
      this.id = options.id;
    }
  }
}
