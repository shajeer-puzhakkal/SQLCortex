import * as vscode from "vscode";
import { getDbCopilotState } from "../../state/dbCopilotState";
import { DbCopilotTreeNode } from "./dbCopilotNodes";

type ProviderDeps = {
  context: vscode.ExtensionContext;
  viewTitle: string;
};

export class DbCopilotPlaceholderProvider
  implements vscode.TreeDataProvider<DbCopilotTreeNode>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    DbCopilotTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly deps: ProviderDeps) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: DbCopilotTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DbCopilotTreeNode): DbCopilotTreeNode[] {
    if (!element) {
      return [this.buildHeaderNode()];
    }
    return element.children;
  }

  private buildHeaderNode(): DbCopilotTreeNode {
    const state = getDbCopilotState(this.deps.context);
    const children: DbCopilotTreeNode[] = [];

    if (!state.connectionLabel) {
      children.push(
        new DbCopilotTreeNode("Connect to a database to get started.", {
          icon: "plug",
        })
      );
      children.push(
        new DbCopilotTreeNode("Connect to Database", {
          icon: "link-external",
          commandId: "dbcopilot.connectDatabase",
        })
      );
    } else if (!state.schemaSnapshotAvailable) {
      children.push(
        new DbCopilotTreeNode("Capture a schema snapshot to unlock insights.", {
          icon: "database",
        })
      );
      children.push(
        new DbCopilotTreeNode("Capture Schema Snapshot", {
          icon: "cloud-download",
          commandId: "dbcopilot.captureSchemaSnapshot",
        })
      );
    } else {
      children.push(
        new DbCopilotTreeNode("Schema snapshot ready.", {
          icon: "check",
        })
      );
    }

    return new DbCopilotTreeNode(this.deps.viewTitle, {
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children,
      icon: "library",
    });
  }
}
