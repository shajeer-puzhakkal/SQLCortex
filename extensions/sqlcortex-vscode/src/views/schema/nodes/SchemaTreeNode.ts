import * as vscode from "vscode";

type SchemaTreeNodeOptions = {
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: SchemaTreeNode[];
  description?: string;
  tooltip?: string;
  icon?: string;
  commandId?: string;
  contextValue?: string;
  id?: string;
};

export class SchemaTreeNode extends vscode.TreeItem {
  readonly children: SchemaTreeNode[];

  constructor(label: string, options?: SchemaTreeNodeOptions) {
    super(label, options?.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.children = options?.children ?? [];
    this.description = options?.description;
    this.tooltip = options?.tooltip ?? label;
    this.contextValue = options?.contextValue;
    if (options?.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
    if (options?.commandId) {
      this.command = { command: options.commandId, title: label };
    }
    if (options?.id) {
      this.id = options.id;
    }
  }
}
