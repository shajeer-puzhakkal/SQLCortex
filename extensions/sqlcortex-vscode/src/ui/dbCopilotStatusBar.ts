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

  const connectionLabel = state.connectionLabel ?? "Connect";
  db.text = `[ DB: ${connectionLabel} ]`;
  db.tooltip = "Select a database connection";
  db.show();

  mode.text = `[ Mode: ${MODE_LABELS[state.mode]} ]`;
  mode.tooltip = "Cycle DB Copilot modes";
  mode.show();

  const policySuffix = state.policiesCount === 1 ? "note" : "notes";
  policies.text = `[ Policies: ${state.policiesCount} ${policySuffix} ]`;
  policies.tooltip = "View active policies";
  policies.show();
}
