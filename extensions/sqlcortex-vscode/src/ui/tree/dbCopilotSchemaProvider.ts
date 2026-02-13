import * as vscode from "vscode";
import { getDbCopilotSchemaSnapshots, getDbCopilotState } from "../../state/dbCopilotState";
import { DbCopilotSchemaNode, DbCopilotTreeNode } from "./dbCopilotNodes";

type ProviderDeps = {
  context: vscode.ExtensionContext;
};

const PLACEHOLDER_SCHEMAS = ["public", "analytics"];

export class DbCopilotSchemaProvider
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
      return this.buildRootNodes();
    }
    return element.children;
  }

  private buildRootNodes(): DbCopilotTreeNode[] {
    const state = getDbCopilotState(this.deps.context);

    if (!state.connectionLabel) {
      return [
        new DbCopilotTreeNode("Schema", {
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
          children: [
            new DbCopilotTreeNode("Select a target to view schemas.", {
              icon: "plug",
            }),
            new DbCopilotTreeNode("Select Target", {
              icon: "link-external",
              commandId: "dbcopilot.selectTarget",
            }),
          ],
        }),
      ];
    }

    if (!state.schemaSnapshotAvailable) {
      return [
        new DbCopilotTreeNode("Schema", {
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
          children: [
            new DbCopilotTreeNode("Capture a schema snapshot to continue.", {
              icon: "database",
            }),
            new DbCopilotTreeNode("Capture Schema Snapshot", {
              icon: "cloud-download",
              commandId: "dbcopilot.captureSchemaSnapshot",
            }),
          ],
        }),
      ];
    }

    const snapshots = getDbCopilotSchemaSnapshots(this.deps.context);
    const schemaNames = snapshots ? Object.keys(snapshots) : PLACEHOLDER_SCHEMAS;
    const schemaNodes = schemaNames.map(
      (schemaName) => new DbCopilotSchemaNode(schemaName)
    );

    return [
      new DbCopilotTreeNode("Schemas", {
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        icon: "symbol-namespace",
        children: schemaNodes,
      }),
      new DbCopilotTreeNode("Right-click a schema for actions.", {
        icon: "info",
      }),
    ];
  }
}
