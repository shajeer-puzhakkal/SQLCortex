import * as vscode from "vscode";
import { clearCachedSession, setCachedSession, verifyToken } from "./auth/session";
import { createTokenStore } from "./auth/tokenStore";

const COMMANDS: Array<{ id: string; label: string }> = [
  { id: "sqlcortex.login", label: "Login" },
  { id: "sqlcortex.logout", label: "Logout" },
  { id: "sqlcortex.selectOrg", label: "Select Org" },
  { id: "sqlcortex.selectProject", label: "Select Project" },
  { id: "sqlcortex.runQuery", label: "Run Query" },
  { id: "sqlcortex.runSelection", label: "Run Selection" },
];

const API_BASE_URL_KEY = "sqlcortex.apiBaseUrl";
const ACTIVE_ORG_KEY = "sqlcortex.activeOrgId";
const ACTIVE_PROJECT_KEY = "sqlcortex.activeProjectId";
const CONTEXT_IS_AUTHED = "sqlcortex.isAuthed";
const DEFAULT_API_BASE_URL = "http://localhost:4000";
const LEGACY_API_BASE_URL = "http://localhost:3000";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("SQLCortex");
  output.appendLine("SQLCortex extension activated.");
  context.subscriptions.push(output);

  void migrateApiBaseUrl(context, output);

  const tokenStore = createTokenStore(context.secrets);
  void syncAuthContext(tokenStore);

  const handlers: Record<string, () => Thenable<unknown>> = {
    "sqlcortex.login": () => loginFlow(context, tokenStore, output),
    "sqlcortex.logout": () => logoutFlow(context, tokenStore, output),
  };

  for (const command of COMMANDS) {
    const handler =
      handlers[command.id] ??
      (() => {
        output.appendLine(`Command executed: ${command.id}`);
        vscode.window.showInformationMessage(
          `SQLCortex: ${command.label} (not yet implemented)`
        );
      });
    const disposable = vscode.commands.registerCommand(command.id, handler);
    context.subscriptions.push(disposable);
  }
}

export function deactivate() {}

async function loginFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel
): Promise<boolean> {
  let baseUrl = await getOrPromptApiBaseUrl(context);
  if (!baseUrl) {
    return false;
  }

  const rawToken = await vscode.window.showInputBox({
    prompt: "SQLCortex API token",
    placeHolder: "Paste your API token",
    password: true,
    ignoreFocusOut: true,
  });

  if (!rawToken) {
    return false;
  }

  const token = rawToken.trim();
  if (!token) {
    vscode.window.showErrorMessage("SQLCortex: Token cannot be empty.");
    return false;
  }

  output.appendLine("SQLCortex: Verifying token...");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await verifyToken(baseUrl, token, clientHeader(context));
      await tokenStore.setAccessToken(token);
      setCachedSession(session);
      await vscode.commands.executeCommand("setContext", CONTEXT_IS_AUTHED, true);

      const displayName = session.user?.name ?? session.user?.email ?? null;
      const successMessage = displayName
        ? `SQLCortex: Logged in as ${displayName}`
        : "SQLCortex: Logged in";
      vscode.window.showInformationMessage(successMessage);
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 && attempt === 0) {
        const choice = await vscode.window.showErrorMessage(
          `SQLCortex: API not found at ${baseUrl}.`,
          "Update base URL"
        );
        if (choice === "Update base URL") {
          const updated = await getOrPromptApiBaseUrl(context, {
            forcePrompt: true,
            initialValue: baseUrl,
          });
          if (!updated) {
            return false;
          }
          baseUrl = updated;
          continue;
        }
      }
      if (status === 401 || status === 403) {
        vscode.window.showErrorMessage("SQLCortex: Invalid token.");
      } else {
        vscode.window.showErrorMessage(`SQLCortex: ${formatError(err)}`);
      }
      return false;
    }
  }
  return false;
}

async function migrateApiBaseUrl(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const stored = context.globalState.get<string>(API_BASE_URL_KEY);
  if (!stored) {
    return;
  }
  const normalized = normalizeBaseUrl(stored);
  if (normalized === LEGACY_API_BASE_URL) {
    await context.globalState.update(API_BASE_URL_KEY, DEFAULT_API_BASE_URL);
    output.appendLine(`SQLCortex: Updated API base URL to ${DEFAULT_API_BASE_URL}.`);
  }
}

async function logoutFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel
): Promise<boolean> {
  await tokenStore.clear();
  clearCachedSession();
  await context.workspaceState.update(ACTIVE_ORG_KEY, undefined);
  await context.workspaceState.update(ACTIVE_PROJECT_KEY, undefined);
  await vscode.commands.executeCommand("setContext", CONTEXT_IS_AUTHED, false);
  output.appendLine("SQLCortex: Logged out.");
  vscode.window.showInformationMessage("SQLCortex: Logged out.");
  return true;
}

async function syncAuthContext(tokenStore: ReturnType<typeof createTokenStore>): Promise<void> {
  const token = await tokenStore.getAccessToken();
  await vscode.commands.executeCommand("setContext", CONTEXT_IS_AUTHED, Boolean(token));
}

async function getOrPromptApiBaseUrl(
  context: vscode.ExtensionContext,
  options?: { forcePrompt?: boolean; initialValue?: string }
): Promise<string | null> {
  const existing = context.globalState.get<string>(API_BASE_URL_KEY);
  if (existing && !options?.forcePrompt) {
    return existing;
  }

  const input = await promptApiBaseUrl(options?.initialValue ?? existing ?? DEFAULT_API_BASE_URL);
  if (!input) {
    return null;
  }

  const normalized = normalizeBaseUrl(input);
  await context.globalState.update(API_BASE_URL_KEY, normalized);
  return normalized;
}

async function promptApiBaseUrl(initialValue: string): Promise<string | null> {
  const input = await vscode.window.showInputBox({
    prompt: "SQLCortex API base URL",
    value: initialValue,
    placeHolder: "https://api.example.com",
    ignoreFocusOut: true,
    validateInput: validateBaseUrl,
  });

  return input ?? null;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function validateBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Base URL is required.";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Base URL must start with http:// or https://";
    }
  } catch {
    return "Base URL is not a valid URL.";
  }
  return undefined;
}

function clientHeader(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  const normalized = typeof version === "string" ? version : "0.0.0";
  return `vscode/${normalized}`;
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Authentication failed.";
}
