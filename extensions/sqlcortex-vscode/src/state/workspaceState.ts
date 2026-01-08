import * as vscode from "vscode";

const ACTIVE_ORG_ID_KEY = "sqlcortex.activeOrgId";
const ACTIVE_ORG_NAME_KEY = "sqlcortex.activeOrgName";
const ACTIVE_PROJECT_ID_KEY = "sqlcortex.activeProjectId";
const ACTIVE_PROJECT_NAME_KEY = "sqlcortex.activeProjectName";
const ACTIVE_CONNECTION_ID_KEY = "sqlcortex.activeConnectionId";
const ACTIVE_CONNECTION_NAME_KEY = "sqlcortex.activeConnectionName";

export type WorkspaceContext = {
  orgId: string | null;
  orgName: string | null;
  projectId: string | null;
  projectName: string | null;
  connectionId: string | null;
  connectionName: string | null;
};

export function getWorkspaceContext(context: vscode.ExtensionContext): WorkspaceContext {
  return {
    orgId: context.workspaceState.get<string | null>(ACTIVE_ORG_ID_KEY, null),
    orgName: context.workspaceState.get<string | null>(ACTIVE_ORG_NAME_KEY, null),
    projectId: context.workspaceState.get<string | null>(ACTIVE_PROJECT_ID_KEY, null),
    projectName: context.workspaceState.get<string | null>(ACTIVE_PROJECT_NAME_KEY, null),
    connectionId: context.workspaceState.get<string | null>(ACTIVE_CONNECTION_ID_KEY, null),
    connectionName: context.workspaceState.get<string | null>(
      ACTIVE_CONNECTION_NAME_KEY,
      null
    ),
  };
}

export async function setActiveOrg(
  context: vscode.ExtensionContext,
  orgId: string | null,
  orgName: string | null
): Promise<void> {
  await context.workspaceState.update(ACTIVE_ORG_ID_KEY, orgId);
  await context.workspaceState.update(ACTIVE_ORG_NAME_KEY, orgName);
}

export async function setActiveProject(
  context: vscode.ExtensionContext,
  projectId: string | null,
  projectName: string | null
): Promise<void> {
  await context.workspaceState.update(ACTIVE_PROJECT_ID_KEY, projectId);
  await context.workspaceState.update(ACTIVE_PROJECT_NAME_KEY, projectName);
}

export async function setActiveConnection(
  context: vscode.ExtensionContext,
  connectionId: string | null,
  connectionName: string | null
): Promise<void> {
  await context.workspaceState.update(ACTIVE_CONNECTION_ID_KEY, connectionId);
  await context.workspaceState.update(ACTIVE_CONNECTION_NAME_KEY, connectionName);
}

export async function clearActiveConnection(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(ACTIVE_CONNECTION_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_CONNECTION_NAME_KEY, undefined);
}

export async function clearActiveProject(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(ACTIVE_PROJECT_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_PROJECT_NAME_KEY, undefined);
  await context.workspaceState.update(ACTIVE_CONNECTION_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_CONNECTION_NAME_KEY, undefined);
}

export async function clearWorkspaceContext(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(ACTIVE_ORG_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_ORG_NAME_KEY, undefined);
  await context.workspaceState.update(ACTIVE_PROJECT_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_PROJECT_NAME_KEY, undefined);
  await context.workspaceState.update(ACTIVE_CONNECTION_ID_KEY, undefined);
  await context.workspaceState.update(ACTIVE_CONNECTION_NAME_KEY, undefined);
}
