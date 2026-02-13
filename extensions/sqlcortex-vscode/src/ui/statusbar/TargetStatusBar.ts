import * as vscode from "vscode";
import type { SelectedTarget } from "../../core/target/TargetStore";

export type TargetStatusBarState = {
  loggedIn: boolean;
  target: SelectedTarget | null;
};

export function createTargetStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = "dbcopilot.selectTarget";
  return item;
}

export function updateTargetStatusBar(
  item: vscode.StatusBarItem,
  state: TargetStatusBarState
): void {
  if (!state.loggedIn) {
    item.text = "$(circle-outline) DB Copilot: Not logged in";
    item.tooltip = "Login with API token";
    item.command = "dbcopilot.loginWithToken";
    item.show();
    return;
  }

  if (!state.target) {
    item.text = "$(circle-large-filled) DB Copilot: Select target";
    item.tooltip = "Select Org / Project / Environment";
    item.command = "dbcopilot.selectTarget";
    item.show();
    return;
  }

  item.text = `$(circle-large-filled) ${state.target.orgName} / ${state.target.projectName} / ${state.target.envName}`;
  item.tooltip = "Active DB Copilot target";
  item.command = "dbcopilot.selectTarget";
  item.show();
}
