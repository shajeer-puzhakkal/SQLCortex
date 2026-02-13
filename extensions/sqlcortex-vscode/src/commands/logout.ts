import * as vscode from "vscode";
import type { ApiSessionManager } from "../core/auth/ApiSessionManager";
import type { LogBus } from "../core/logging/LogBus";
import type { TargetStore } from "../core/target/TargetStore";

type LogoutDeps = {
  sessionManager: ApiSessionManager;
  targetStore: TargetStore;
  logBus: LogBus;
  onDidLogout?: () => Promise<void>;
};

export function createLogoutCommand(deps: LogoutDeps): () => Promise<void> {
  return async () => {
    try {
      await deps.sessionManager.logout();
      await deps.targetStore.clearSelectedTarget();
      await deps.onDidLogout?.();
      deps.logBus.log("Logged out and cleared selected target.");
      vscode.window.showInformationMessage("DB Copilot: Logged out.");
    } catch (err) {
      deps.logBus.error("Logout failed.", err);
      const message = deps.sessionManager.formatError(err);
      vscode.window.showErrorMessage(`DB Copilot: ${message}`);
    }
  };
}
