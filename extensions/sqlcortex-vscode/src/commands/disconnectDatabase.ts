import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connection/ConnectionManager";
import type { LogBus } from "../core/logging/LogBus";

type DisconnectDatabaseDeps = {
  connectionManager: ConnectionManager;
  logBus: LogBus;
};

export function createDisconnectDatabaseCommand(
  deps: DisconnectDatabaseDeps
): () => Promise<void> {
  return async () => {
    if (!deps.connectionManager.getConnectionProfile()) {
      vscode.window.showInformationMessage("DB Copilot: No active connection.");
      return;
    }
    try {
      await deps.connectionManager.disconnect();
      vscode.window.showInformationMessage("DB Copilot: Disconnected.");
    } catch (err) {
      deps.logBus.error("Failed to disconnect.", err);
      vscode.window.showErrorMessage("DB Copilot: Failed to disconnect.");
    }
  };
}
