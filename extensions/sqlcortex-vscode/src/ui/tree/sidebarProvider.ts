import * as vscode from "vscode";
import type { TokenStore } from "../../auth/tokenStore";
import { getWorkspaceContext, type WorkspaceContext } from "../../state/workspaceState";
import {
  SidebarActionNode,
  SidebarInfoNode,
  SidebarSectionNode,
  type SidebarNode,
} from "./sidebarNodes";

type ProviderDependencies = {
  context: vscode.ExtensionContext;
  tokenStore: TokenStore;
};

export class SidebarProvider implements vscode.TreeDataProvider<SidebarNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    SidebarNode | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly deps: ProviderDependencies) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: SidebarNode): vscode.TreeItem {
    return element;
  }

  getParent(element: SidebarNode): SidebarNode | undefined {
    return element.parent;
  }

  async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (!element) {
      return this.getRootNodes();
    }

    if (element.kind === "section") {
      return element.children;
    }

    return [];
  }

  private async getRootNodes(): Promise<SidebarNode[]> {
    const token = await this.deps.tokenStore.getAccessToken();
    const isAuthed = Boolean(token);
    const workspace = getWorkspaceContext(this.deps.context);

    return [
      this.buildStatusSection(isAuthed, workspace),
      this.buildWorkspaceSection(isAuthed, workspace),
      this.buildActionsSection(isAuthed),
    ];
  }

  private buildStatusSection(
    isAuthed: boolean,
    workspace: WorkspaceContext
  ): SidebarSectionNode {
    const children: SidebarNode[] = [];

    const sessionLabel = isAuthed ? "Session: Signed in" : "Session: Signed out";
    const sessionIcon = isAuthed ? "account" : "debug-disconnect";
    const sessionCommand = isAuthed ? "sqlcortex.logout" : "sqlcortex.login";
    const sessionTooltip = isAuthed
      ? "Signed in to SQLCortex (click to log out)"
      : "Sign in to SQLCortex";
    children.push(
      new SidebarInfoNode(sessionLabel, {
        icon: sessionIcon,
        tooltip: sessionTooltip,
        commandId: sessionCommand,
      })
    );

    const connectionNode = this.buildConnectionStatusNode(isAuthed, workspace);
    children.push(connectionNode);

    return new SidebarSectionNode("Status", children);
  }

  private buildConnectionStatusNode(
    isAuthed: boolean,
    workspace: WorkspaceContext
  ): SidebarInfoNode {
    if (!isAuthed) {
      return new SidebarInfoNode("Connection: Sign in", {
        icon: "debug-disconnect",
        tooltip: "Sign in to select a connection",
        commandId: "sqlcortex.login",
      });
    }

    if (!workspace.projectId) {
      return new SidebarInfoNode("Connection: Select project", {
        icon: "debug-disconnect",
        tooltip: "Select a project first",
        commandId: "sqlcortex.selectProject",
      });
    }

    if (workspace.connectionName) {
      return new SidebarInfoNode(`Connection: ${workspace.connectionName}`, {
        icon: "database",
        tooltip: "Active connection (click to change)",
        commandId: "sqlcortex.selectConnection",
      });
    }

    if (workspace.connectionId) {
      return new SidebarInfoNode("Connection: Selected", {
        icon: "database",
        tooltip: "Active connection (click to change)",
        commandId: "sqlcortex.selectConnection",
      });
    }

    return new SidebarInfoNode("Connection: Select", {
      icon: "debug-disconnect",
      tooltip: "Select a connection",
      commandId: "sqlcortex.selectConnection",
    });
  }

  private buildWorkspaceSection(
    isAuthed: boolean,
    workspace: WorkspaceContext
  ): SidebarSectionNode {
    const children: SidebarNode[] = [];

    if (!isAuthed) {
      children.push(
        new SidebarInfoNode("Org: Sign in", {
          icon: "account",
          tooltip: "Sign in to select an org",
          commandId: "sqlcortex.login",
        })
      );
      children.push(
        new SidebarInfoNode("Project: Sign in", {
          icon: "account",
          tooltip: "Sign in to select a project",
          commandId: "sqlcortex.login",
        })
      );
      return new SidebarSectionNode("Workspace", children);
    }

    const orgLabel = workspace.orgName ? `Org: ${workspace.orgName}` : "Org: Select";
    const orgTooltip = workspace.orgName
      ? "Active org (click to change)"
      : "Select an org";
    children.push(
      new SidebarInfoNode(orgLabel, {
        icon: "account",
        tooltip: orgTooltip,
        commandId: "sqlcortex.selectOrg",
      })
    );

    let projectLabel = "Project: Select";
    let projectTooltip = "Select a project";
    let projectCommand = "sqlcortex.selectProject";
    if (!workspace.orgName) {
      projectLabel = "Project: Select org";
      projectTooltip = "Select an org first";
      projectCommand = "sqlcortex.selectOrg";
    } else if (workspace.projectName) {
      projectLabel = `Project: ${workspace.projectName}`;
      projectTooltip = "Active project (click to change)";
    }

    children.push(
      new SidebarInfoNode(projectLabel, {
        icon: "folder",
        tooltip: projectTooltip,
        commandId: projectCommand,
      })
    );

    return new SidebarSectionNode("Workspace", children);
  }

  private buildActionsSection(isAuthed: boolean): SidebarSectionNode {
    const children: SidebarNode[] = [];

    if (isAuthed) {
      children.push(
        new SidebarActionNode("Logout", "sqlcortex.logout", { icon: "account" })
      );
    } else {
      children.push(
        new SidebarActionNode("Login", "sqlcortex.login", { icon: "account" })
      );
    }

    children.push(
      new SidebarActionNode("Select Org", "sqlcortex.selectOrg", { icon: "account" })
    );
    children.push(
      new SidebarActionNode("Select Project", "sqlcortex.selectProject", { icon: "folder" })
    );
    children.push(
      new SidebarActionNode("Select Connection", "sqlcortex.selectConnection", {
        icon: "database",
      })
    );
    children.push(
      new SidebarActionNode("Run Query", "sqlcortex.runQuery", { icon: "play" })
    );
    children.push(
      new SidebarActionNode("Run Selection", "sqlcortex.runSelection", {
        icon: "play",
      })
    );
    children.push(
      new SidebarActionNode("Search Table", "sqlcortex.searchTable", { icon: "search" })
    );
    children.push(
      new SidebarActionNode("Refresh Explorer", "sqlcortex.refreshExplorer", {
        icon: "refresh",
      })
    );

    return new SidebarSectionNode("Quick Actions", children);
  }
}
