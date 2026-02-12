import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connection/ConnectionManager";
import type { LogBus } from "../core/logging/LogBus";

type RefreshSchemaDeps = {
  connectionManager: ConnectionManager;
  logBus: LogBus;
};

export function createRefreshSchemaCommand(deps: RefreshSchemaDeps): () => Promise<void> {
  return async () => {
    if (!deps.connectionManager.getConnectionProfile()) {
      vscode.window.showWarningMessage("DB Copilot: Connect to a database first.");
      return;
    }
    try {
      await deps.connectionManager.reconnect();
      deps.logBus.log("Connection refreshed. Schema refresh is a stub in this phase.");
      vscode.window.showInformationMessage("DB Copilot: Connection refreshed.");
    } catch (err) {
      deps.logBus.error("Failed to refresh connection.", err);
      vscode.window.showErrorMessage("DB Copilot: Failed to refresh connection.");
    }
  };
}
