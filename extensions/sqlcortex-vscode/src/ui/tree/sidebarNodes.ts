import * as vscode from "vscode";

export type SidebarNode = SidebarSectionNode | SidebarInfoNode | SidebarActionNode;

type NodeKind = "section" | "info" | "action";

abstract class SidebarBaseNode<K extends NodeKind> extends vscode.TreeItem {
  readonly kind: K;
  readonly parent?: SidebarNode;

  protected constructor(
    kind: K,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    parent?: SidebarNode
  ) {
    super(label, collapsibleState);
    this.kind = kind;
    this.parent = parent;
  }
}

export class SidebarSectionNode extends SidebarBaseNode<"section"> {
  readonly children: SidebarNode[];

  constructor(label: string, children: SidebarNode[]) {
    super("section", label, vscode.TreeItemCollapsibleState.Expanded);
    this.children = children;
    this.id = `sqlcortex.sidebar.section.${label.toLowerCase().replace(/\s+/g, "-")}`;
  }
}

export class SidebarInfoNode extends SidebarBaseNode<"info"> {
  constructor(
    label: string,
    options: {
      parent?: SidebarNode;
      description?: string;
      tooltip?: string;
      icon?: string;
      commandId?: string;
    }
  ) {
    super("info", label, vscode.TreeItemCollapsibleState.None, options.parent);
    this.description = options.description;
    this.tooltip = options.tooltip;
    if (options.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
    if (options.commandId) {
      this.command = { command: options.commandId, title: label };
    }
  }
}

export class SidebarActionNode extends SidebarBaseNode<"action"> {
  constructor(
    label: string,
    commandId: string,
    options?: { parent?: SidebarNode; tooltip?: string; icon?: string }
  ) {
    super("action", label, vscode.TreeItemCollapsibleState.None, options?.parent);
    this.command = { command: commandId, title: label };
    this.contextValue = "sqlcortex.sidebarAction";
    this.tooltip = options?.tooltip ?? label;
    if (options?.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
  }
}
