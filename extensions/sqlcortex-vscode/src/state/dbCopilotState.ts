import * as vscode from "vscode";

export type DbCopilotMode = "readOnly" | "draft" | "execution";

export type DbCopilotState = {
  connectionLabel: string | null;
  schemaSnapshotAvailable: boolean;
  mode: DbCopilotMode;
};

const CONNECTION_LABEL_KEY = "dbcopilot.connectionLabel";
const SCHEMA_SNAPSHOT_KEY = "dbcopilot.schemaSnapshotAvailable";
const MODE_KEY = "dbcopilot.mode";

const DEFAULT_MODE: DbCopilotMode = "readOnly";

export function getDbCopilotState(
  context: vscode.ExtensionContext
): DbCopilotState {
  return {
    connectionLabel: context.workspaceState.get<string | null>(
      CONNECTION_LABEL_KEY,
      null
    ),
    schemaSnapshotAvailable: context.workspaceState.get<boolean>(
      SCHEMA_SNAPSHOT_KEY,
      false
    ),
    mode: context.workspaceState.get<DbCopilotMode>(MODE_KEY, DEFAULT_MODE),
  };
}

export async function setDbCopilotConnection(
  context: vscode.ExtensionContext,
  connectionLabel: string | null
): Promise<void> {
  await context.workspaceState.update(CONNECTION_LABEL_KEY, connectionLabel);
  if (!connectionLabel) {
    await context.workspaceState.update(SCHEMA_SNAPSHOT_KEY, false);
  }
}

export async function setDbCopilotSchemaSnapshot(
  context: vscode.ExtensionContext,
  available: boolean
): Promise<void> {
  await context.workspaceState.update(SCHEMA_SNAPSHOT_KEY, available);
}

export async function setDbCopilotMode(
  context: vscode.ExtensionContext,
  mode: DbCopilotMode
): Promise<void> {
  await context.workspaceState.update(MODE_KEY, mode);
}
