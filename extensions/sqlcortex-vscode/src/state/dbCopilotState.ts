import * as vscode from "vscode";
import type { DbCopilotSchemaSnapshot, DbCopilotSchemaSnapshots } from "../dbcopilot/schemaSnapshot";

export type DbCopilotMode = "readOnly" | "draft" | "execution";

export type DbCopilotState = {
  connectionLabel: string | null;
  connectionDisplayLabel: string | null;
  connectionReadOnly: boolean | null;
  schemaSnapshotAvailable: boolean;
  mode: DbCopilotMode;
};

const CONNECTION_LABEL_KEY = "dbcopilot.connectionLabel";
const CONNECTION_DISPLAY_LABEL_KEY = "dbcopilot.connectionDisplayLabel";
const CONNECTION_READONLY_KEY = "dbcopilot.connectionReadOnly";
const SCHEMA_SNAPSHOT_KEY = "dbcopilot.schemaSnapshotAvailable";
const SCHEMA_SNAPSHOT_DATA_KEY = "dbcopilot.schemaSnapshotData";
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
    connectionDisplayLabel: context.workspaceState.get<string | null>(
      CONNECTION_DISPLAY_LABEL_KEY,
      null
    ),
    connectionReadOnly: context.workspaceState.get<boolean | null>(
      CONNECTION_READONLY_KEY,
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
  connectionLabel: string | null,
  displayLabel?: string | null,
  readOnly?: boolean | null
): Promise<void> {
  await context.workspaceState.update(CONNECTION_LABEL_KEY, connectionLabel);
  await context.workspaceState.update(
    CONNECTION_DISPLAY_LABEL_KEY,
    displayLabel ?? connectionLabel
  );
  await context.workspaceState.update(CONNECTION_READONLY_KEY, readOnly ?? null);
  if (!connectionLabel) {
    await context.workspaceState.update(SCHEMA_SNAPSHOT_KEY, false);
    await context.workspaceState.update(SCHEMA_SNAPSHOT_DATA_KEY, null);
  }
}

export async function setDbCopilotSchemaSnapshot(
  context: vscode.ExtensionContext,
  available: boolean
): Promise<void> {
  await context.workspaceState.update(SCHEMA_SNAPSHOT_KEY, available);
}

export function getDbCopilotSchemaSnapshots(
  context: vscode.ExtensionContext
): DbCopilotSchemaSnapshots | null {
  return context.workspaceState.get<DbCopilotSchemaSnapshots | null>(
    SCHEMA_SNAPSHOT_DATA_KEY,
    null
  );
}

export function getDbCopilotSchemaSnapshot(
  context: vscode.ExtensionContext,
  schemaName: string | null | undefined
): DbCopilotSchemaSnapshot | null {
  if (!schemaName) {
    return null;
  }
  const snapshots = getDbCopilotSchemaSnapshots(context);
  if (!snapshots) {
    return null;
  }
  return snapshots[schemaName] ?? snapshots[schemaName.toLowerCase()] ?? null;
}

export async function setDbCopilotSchemaSnapshots(
  context: vscode.ExtensionContext,
  snapshots: DbCopilotSchemaSnapshots | null
): Promise<void> {
  await context.workspaceState.update(SCHEMA_SNAPSHOT_DATA_KEY, snapshots);
}

export async function setDbCopilotMode(
  context: vscode.ExtensionContext,
  mode: DbCopilotMode
): Promise<void> {
  await context.workspaceState.update(MODE_KEY, mode);
}
