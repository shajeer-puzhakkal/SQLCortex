import * as vscode from "vscode";
import type { ApiSessionManager } from "../core/auth/ApiSessionManager";
import type { LogBus } from "../core/logging/LogBus";

type LoginWithTokenDeps = {
  sessionManager: ApiSessionManager;
  logBus: LogBus;
  onDidLogin?: () => Promise<void>;
};

export function createLoginWithTokenCommand(
  deps: LoginWithTokenDeps
): () => Promise<void> {
  return async () => {
    const rawToken = await vscode.window.showInputBox({
      prompt: "DB Copilot API token",
      placeHolder: "Paste your API token",
      password: true,
      ignoreFocusOut: true,
    });

    if (!rawToken) {
      return;
    }

    try {
      const session = await deps.sessionManager.loginWithToken(rawToken);
      deps.logBus.log("API token login succeeded.");
      await deps.onDidLogin?.();
      const displayName = session.user?.name ?? session.user?.email ?? "user";
      vscode.window.showInformationMessage(`DB Copilot: Logged in as ${displayName}.`);
    } catch (err) {
      deps.logBus.error("API token login failed.", err);
      const message = deps.sessionManager.formatError(err);
      vscode.window.showErrorMessage(`DB Copilot: ${message}`);
    }
  };
}
