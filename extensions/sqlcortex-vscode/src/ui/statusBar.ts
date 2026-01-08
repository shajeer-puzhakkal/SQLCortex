import * as vscode from "vscode";
import { WorkspaceContext } from "../state/workspaceState";

export type StatusBarState = WorkspaceContext & { isAuthed: boolean };

export type StatusBarItems = {
  workspace: vscode.StatusBarItem;
  connection: vscode.StatusBarItem;
  runQuery: vscode.StatusBarItem;
};

export function createStatusBarItems(): StatusBarItems {
  const workspace = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  const connection = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  const runQuery = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98
  );

  runQuery.command = "sqlcortex.runQuery";
  return { workspace, connection, runQuery };
}

export function updateStatusBar(items: StatusBarItems, state: StatusBarState): void {
  const { workspace, connection, runQuery } = items;

  if (!state.isAuthed) {
    workspace.text = "SQLCortex: Sign in";
    workspace.tooltip = "Sign in to SQLCortex";
    workspace.command = "sqlcortex.login";
    workspace.show();
    connection.hide();
    runQuery.hide();
    return;
  }

  if (state.projectName) {
    const orgLabel = state.orgName ?? "Personal";
    workspace.text = `SQLCortex: ${orgLabel} / ${state.projectName}`;
    workspace.tooltip = "Active project (click to change)";
    workspace.command = "sqlcortex.selectProject";
    workspace.show();
  } else if (state.orgName) {
    workspace.text = `SQLCortex: ${state.orgName} / Select project`;
    workspace.tooltip = "Select a project to run queries";
    workspace.command = "sqlcortex.selectProject";
    workspace.show();
  } else {
    workspace.text = "SQLCortex: Select org";
    workspace.tooltip = "Select an org to get started";
    workspace.command = "sqlcortex.selectOrg";
    workspace.show();
  }

  if (!state.projectId) {
    connection.text = "$(database) Connection: Select project";
    connection.tooltip = "Select a project first";
    connection.command = "sqlcortex.selectProject";
  } else if (state.connectionName) {
    connection.text = `$(database) ${state.connectionName}`;
    connection.tooltip = "Active connection (click to change)";
    connection.command = "sqlcortex.selectConnection";
  } else if (state.connectionId) {
    connection.text = "$(database) Connection: Selected";
    connection.tooltip = "Active connection (click to change)";
    connection.command = "sqlcortex.selectConnection";
  } else {
    connection.text = "$(database) Connection: Select";
    connection.tooltip = "Select a connection";
    connection.command = "sqlcortex.selectConnection";
  }
  connection.show();

  runQuery.text = "$(play) Run query";
  runQuery.tooltip = "Run the current SQL (smart mode)";
  runQuery.command = "sqlcortex.runQuery";
  runQuery.show();
}
