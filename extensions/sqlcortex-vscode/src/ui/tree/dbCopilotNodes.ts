import * as vscode from "vscode";

export class DbCopilotTreeNode extends vscode.TreeItem {
  readonly children: DbCopilotTreeNode[];

  constructor(
    label: string,
    options?: {
      collapsibleState?: vscode.TreeItemCollapsibleState;
      children?: DbCopilotTreeNode[];
      description?: string;
      tooltip?: string;
      icon?: string;
      commandId?: string;
      contextValue?: string;
      id?: string;
    }
  ) {
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

export class DbCopilotSchemaNode extends DbCopilotTreeNode {
  readonly schemaName: string;

  constructor(schemaName: string) {
    super(schemaName, {
      icon: "symbol-namespace",
      contextValue: "dbcopilot.schema",
      id: `dbcopilot.schema.${schemaName}`,
    });
    this.schemaName = schemaName;
  }
}
