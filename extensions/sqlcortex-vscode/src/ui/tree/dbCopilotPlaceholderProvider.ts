import * as vscode from "vscode";
import {
  getDbCopilotSchemaSnapshots,
  getDbCopilotState,
} from "../../state/dbCopilotState";
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
    const config = vscode.workspace.getConfiguration("sqlcortex");
    const showMeter = Boolean(config.get<boolean>("metering.enabled"));

    if (!state.connectionLabel) {
      children.push(
        new DbCopilotTreeNode("Login and select a target to get started.", {
          icon: "plug",
        })
      );
      children.push(
        new DbCopilotTreeNode("Select Target", {
          icon: "link-external",
          commandId: "dbcopilot.selectTarget",
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
      children.push(...this.buildReadyNodes(state.connectionDisplayLabel));
    }

    if (showMeter && this.deps.viewTitle === "Overview") {
      children.push(
        new DbCopilotTreeNode("Today: 23 credits used / 100 remaining", {
          icon: "dashboard",
        })
      );
    }

    return new DbCopilotTreeNode(this.deps.viewTitle, {
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children,
      icon: "library",
    });
  }

  private buildReadyNodes(connectionDisplayLabel: string | null): DbCopilotTreeNode[] {
    const snapshots = getDbCopilotSchemaSnapshots(this.deps.context);
    const summary = summarizeSnapshots(snapshots);

    switch (this.deps.viewTitle) {
      case "Overview":
        return [
          new DbCopilotTreeNode("Schema snapshot ready.", { icon: "check" }),
          new DbCopilotTreeNode(`Connection: ${connectionDisplayLabel ?? "Connected"}`, {
            icon: "plug",
          }),
          new DbCopilotTreeNode(
            `Snapshot: ${summary.schemaCount} schemas, ${summary.tableCount} tables`,
            { icon: "database" }
          ),
          new DbCopilotTreeNode("Refresh Schema", {
            icon: "refresh",
            commandId: "dbcopilot.refreshSchema",
          }),
        ];
      case "Agents":
        return [
          new DbCopilotTreeNode("Agent graph ready.", { icon: "hubot" }),
          new DbCopilotTreeNode("Optimize Current Query", {
            icon: "sparkle",
            commandId: "dbcopilot.optimizeCurrentQuery",
          }),
          new DbCopilotTreeNode("Analyze Schema Health", {
            icon: "pulse",
            commandId: "dbcopilot.analyzeSchemaHealth",
          }),
          new DbCopilotTreeNode("Open Agent Logs", {
            icon: "output",
            commandId: "dbcopilot.openAgentLogs",
          }),
        ];
      case "Recommendations":
        return [
          new DbCopilotTreeNode("No recommendations generated yet.", {
            icon: "lightbulb",
          }),
          new DbCopilotTreeNode("Run Optimize Current Query", {
            icon: "sparkle",
            commandId: "dbcopilot.optimizeCurrentQuery",
          }),
          new DbCopilotTreeNode("Open Optimization Plan", {
            icon: "list-tree",
            commandId: "dbcopilot.openOptimizationPlan",
          }),
        ];
      case "Migrations":
        return [
          new DbCopilotTreeNode("No migration plan generated yet.", {
            icon: "source-control",
          }),
          new DbCopilotTreeNode("Open Migration Plan", {
            icon: "notebook",
            commandId: "dbcopilot.openMigrationPlan",
          }),
          new DbCopilotTreeNode("Save Migration", {
            icon: "save",
            commandId: "dbcopilot.saveMigration",
          }),
          new DbCopilotTreeNode("Execute Migration", {
            icon: "play",
            commandId: "dbcopilot.executeMigration",
          }),
        ];
      default:
        return [
          new DbCopilotTreeNode("Schema snapshot ready.", {
            icon: "check",
          }),
        ];
    }
  }
}

function summarizeSnapshots(
  snapshots: ReturnType<typeof getDbCopilotSchemaSnapshots>
): {
  schemaCount: number;
  tableCount: number;
} {
  if (!snapshots) {
    return {
      schemaCount: 0,
      tableCount: 0,
    };
  }

  const schemas = Object.values(snapshots);
  const tableCount = schemas.reduce((sum, schema) => sum + schema.tables.length, 0);
  return {
    schemaCount: schemas.length,
    tableCount,
  };
}
