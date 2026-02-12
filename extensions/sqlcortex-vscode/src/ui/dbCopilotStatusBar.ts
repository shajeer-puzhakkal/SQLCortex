import * as vscode from "vscode";
import type { DbCopilotMode, DbCopilotState } from "../state/dbCopilotState";

export type DbCopilotStatusBarItems = {
  db: vscode.StatusBarItem;
  mode: vscode.StatusBarItem;
  policies: vscode.StatusBarItem;
};

const MODE_LABELS: Record<DbCopilotMode, string> = {
  readOnly: "Read-Only",
  draft: "Draft",
  execution: "Execution",
};

export function createDbCopilotStatusBarItems(): DbCopilotStatusBarItems {
  const db = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    96
  );
  const mode = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    95
  );
  const policies = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    94
  );

  db.command = "dbcopilot.connectDatabase";
  mode.command = "dbcopilot.toggleMode";
  policies.command = "dbcopilot.viewPolicies";

  return { db, mode, policies };
}

export function updateDbCopilotStatusBar(
  items: DbCopilotStatusBarItems,
  state: DbCopilotState & { policiesCount: number }
): void {
  const { db, mode, policies } = items;

  const displayLabel = state.connectionDisplayLabel ?? state.connectionLabel;
  if (displayLabel) {
    const modeLabel = state.connectionReadOnly ? "Read-Only" : "Write";
    db.text = `$(circle-filled) Connected: ${displayLabel} (Mode: ${modeLabel})`;
    db.tooltip = "Manage database connection";
  } else {
    db.text = "$(circle-outline) Disconnected";
    db.tooltip = "Connect to a database";
  }
  db.show();

  mode.text = `[ Mode: ${MODE_LABELS[state.mode]} ]`;
  mode.tooltip = "Cycle DB Copilot modes";
  mode.show();

  const policySuffix = state.policiesCount === 1 ? "note" : "notes";
  policies.text = `[ Policies: ${state.policiesCount} ${policySuffix} ]`;
  policies.tooltip = "View active policies";
  policies.show();
}
