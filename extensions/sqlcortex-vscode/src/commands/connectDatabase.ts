import * as vscode from "vscode";
import { randomUUID } from "crypto";
import type { ConnectionProfile, ConnectionSslMode } from "../core/connection/ConnectionTypes";
import type { ConnectionManager } from "../core/connection/ConnectionManager";
import type { ConnectionProfileStore } from "../core/connection/ConnectionProfileStore";
import type { LogBus } from "../core/logging/LogBus";

type ConnectDatabaseDeps = {
  connectionManager: ConnectionManager;
  profileStore: ConnectionProfileStore;
  logBus: LogBus;
};

type ConnectionQuickPickItem = vscode.QuickPickItem & {
  action: "connect" | "add" | "disconnect";
  profileId?: string;
};

const DEFAULT_PORT = "5432";

export function createConnectDatabaseCommand(deps: ConnectDatabaseDeps): () => Promise<void> {
  return async () => {
    const profiles = deps.profileStore.listProfiles();
    const connectedProfile = deps.connectionManager.getConnectionProfile();

    const items: ConnectionQuickPickItem[] = [];
    if (connectedProfile) {
      items.push({
        label: "Disconnect",
        description: deps.connectionManager.getConnectionLabel() ?? "",
        action: "disconnect",
      });
    }

    for (const profile of profiles) {
      items.push({
        label: profile.name,
        description: `${profile.user}@${profile.host}:${profile.port}/${profile.database}`,
        detail: profile.readOnly ? "Read-Only" : "Write",
        action: "connect",
        profileId: profile.id,
        picked: connectedProfile?.id === profile.id,
      });
    }

    items.push({
      label: "+ Add new connection",
      action: "add",
      description: "Create a new Postgres connection profile",
    });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: connectedProfile
        ? "Select a connection or disconnect"
        : "Select a connection",
      ignoreFocusOut: true,
    });

    if (!selection) {
      return;
    }

    if (selection.action === "disconnect") {
      await disconnectCurrent(deps);
      return;
    }

    if (selection.action === "add") {
      const profile = await promptForNewProfile();
      if (!profile) {
        return;
      }
      const password = await promptForPassword();
      if (password === null) {
        return;
      }
      try {
        await deps.profileStore.saveProfile(profile);
        await deps.profileStore.setPassword(profile.id, password);
        deps.logBus.log(`Saved connection profile "${profile.name}".`);
      } catch (err) {
        deps.logBus.error(`Failed to save connection profile "${profile.name}".`, err);
        vscode.window.showErrorMessage("DB Copilot: Failed to save connection profile.");
        return;
      }
      await connectProfile(deps, profile.id, profile.name);
      return;
    }

    if (selection.profileId) {
      await connectProfile(deps, selection.profileId, selection.label);
    }
  };
}

async function connectProfile(
  deps: ConnectDatabaseDeps,
  profileId: string,
  label: string
): Promise<void> {
  try {
    await deps.connectionManager.connect(profileId);
    const connectedLabel = deps.connectionManager.getConnectionLabel() ?? label;
    vscode.window.showInformationMessage(`DB Copilot: Connected to ${connectedLabel}.`);
  } catch (err) {
    deps.logBus.error(`Failed to connect to ${label}.`, err);
    vscode.window.showErrorMessage("DB Copilot: Failed to connect to database.");
  }
}

async function disconnectCurrent(deps: ConnectDatabaseDeps): Promise<void> {
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
}

async function promptForNewProfile(): Promise<ConnectionProfile | null> {
  const name = await promptRequiredInput("Connection name", "staging");
  if (name === null) {
    return null;
  }
  const host = await promptRequiredInput("Host", "localhost");
  if (host === null) {
    return null;
  }
  const portInput = await promptPort();
  if (portInput === null) {
    return null;
  }
  const database = await promptRequiredInput("Database", "postgres");
  if (database === null) {
    return null;
  }
  const user = await promptRequiredInput("User", "postgres");
  if (user === null) {
    return null;
  }
  const sslMode = await promptSslMode();
  if (!sslMode) {
    return null;
  }
  const readOnly = await promptReadOnly();
  if (readOnly === null) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    host,
    port: portInput,
    database,
    user,
    sslMode,
    readOnly,
    createdAt: now,
    updatedAt: now,
  };
}

async function promptRequiredInput(prompt: string, value?: string): Promise<string | null> {
  const result = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? null : "Required."),
  });
  if (result === undefined) {
    return null;
  }
  return result.trim();
}

async function promptPort(): Promise<number | null> {
  const result = await vscode.window.showInputBox({
    prompt: "Port",
    value: DEFAULT_PORT,
    ignoreFocusOut: true,
    validateInput: (input) => {
      const parsed = Number.parseInt(input, 10);
      if (Number.isNaN(parsed)) {
        return "Enter a number.";
      }
      if (parsed <= 0 || parsed > 65535) {
        return "Port must be between 1 and 65535.";
      }
      return null;
    },
  });
  if (result === undefined) {
    return null;
  }
  return Number.parseInt(result, 10);
}

async function promptForPassword(): Promise<string | null> {
  const result = await vscode.window.showInputBox({
    prompt: "Password",
    ignoreFocusOut: true,
    password: true,
    validateInput: (input) => (input.trim() ? null : "Required."),
  });
  if (result === undefined) {
    return null;
  }
  return result;
}

async function promptSslMode(): Promise<ConnectionSslMode | null> {
  const selection = await vscode.window.showQuickPick(
    [
      { label: "prefer", description: "Use SSL if available" },
      { label: "require", description: "Always use SSL" },
      { label: "disable", description: "Do not use SSL" },
    ],
    {
      placeHolder: "Select SSL mode",
      ignoreFocusOut: true,
    }
  );
  if (!selection) {
    return null;
  }
  return selection.label as ConnectionSslMode;
}

async function promptReadOnly(): Promise<boolean | null> {
  const selection = await vscode.window.showQuickPick(
    [
      { label: "Read-Only", description: "Disable write operations in DB Copilot." },
      { label: "Write", description: "Enable write operations in DB Copilot." },
    ],
    {
      placeHolder: "Select connection mode",
      ignoreFocusOut: true,
    }
  );
  if (!selection) {
    return null;
  }
  return selection.label === "Read-Only";
}
