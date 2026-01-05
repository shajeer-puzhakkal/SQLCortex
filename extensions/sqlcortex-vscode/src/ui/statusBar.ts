import * as vscode from "vscode";
import { WorkspaceContext } from "../state/workspaceState";

export type StatusBarState = WorkspaceContext & { isAuthed: boolean };

export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "sqlcortex.selectProject";
  return item;
}

export function updateStatusBar(item: vscode.StatusBarItem, state: StatusBarState): void {
  if (!state.isAuthed) {
    item.text = "SQLCortex: Sign in";
    item.tooltip = "Sign in to SQLCortex";
    item.command = "sqlcortex.login";
    item.show();
    return;
  }

  if (state.projectName) {
    const orgLabel = state.orgName ?? "Personal";
    item.text = `SQLCortex: ${orgLabel} / ${state.projectName}`;
    item.tooltip = "Active project (click to change)";
    item.command = "sqlcortex.selectProject";
    item.show();
    return;
  }

  if (state.orgName) {
    item.text = `SQLCortex: ${state.orgName} / Select project`;
    item.tooltip = "Select a project to run queries";
    item.command = "sqlcortex.selectProject";
    item.show();
    return;
  }

  item.text = "SQLCortex: Select project";
  item.tooltip = "Select a project to run queries";
  item.command = "sqlcortex.selectProject";
  item.show();
}
