import * as vscode from "vscode";
import { listConnections, listOrgs, listProjects } from "../api/endpoints";
import type { ConnectionResource } from "../api/types";
import type { ApiClient } from "../core/api/ApiClient";
import type { ApiSessionManager } from "../core/auth/ApiSessionManager";
import type { LogBus } from "../core/logging/LogBus";
import type { SelectedTarget, TargetStore } from "../core/target/TargetStore";

type SelectTargetDeps = {
  sessionManager: ApiSessionManager;
  targetStore: TargetStore;
  logBus: LogBus;
  onTargetSelected?: (target: SelectedTarget) => Promise<void>;
};

type OrgPickItem = vscode.QuickPickItem & { orgId: string | null };
type ProjectPickItem = vscode.QuickPickItem & { projectId: string };
type EnvPickItem = vscode.QuickPickItem & { envId: string; envName: string };

export function createSelectTargetCommand(
  deps: SelectTargetDeps
): () => Promise<void> {
  return async () => {
    const token = await deps.sessionManager.getToken();
    if (!token) {
      const choice = await vscode.window.showWarningMessage(
        "DB Copilot: Login with token first.",
        "Login with Token"
      );
      if (choice === "Login with Token") {
        await vscode.commands.executeCommand("dbcopilot.loginWithToken");
      }
      return;
    }

    try {
      const client = await deps.sessionManager.getClientOrThrow();
      const selected = deps.targetStore.getSelectedTarget();

      const org = await pickOrg(client, selected?.orgId ?? null, selected?.orgName ?? null);
      if (!org) {
        return;
      }

      const project = await pickProject(
        client,
        org.orgId,
        org.label,
        selected?.projectId ?? null
      );
      if (!project) {
        return;
      }

      const env = await pickEnvironment(
        client,
        project.projectId,
        selected?.envId ?? null
      );
      if (!env) {
        return;
      }

      const target: SelectedTarget = {
        orgId: org.orgId,
        orgName: org.label,
        projectId: project.projectId,
        projectName: project.label,
        envId: env.envId,
        envName: env.envName,
      };

      await deps.targetStore.setSelectedTarget(target);
      await deps.onTargetSelected?.(target);
      deps.logBus.log(
        `Selected target ${target.orgName} / ${target.projectName} / ${target.envName}.`
      );
      vscode.window.showInformationMessage(
        `DB Copilot: Target set to ${target.orgName} / ${target.projectName} / ${target.envName}.`
      );
    } catch (err) {
      deps.logBus.error("Target selection failed.", err);
      const message = deps.sessionManager.formatError(err);
      vscode.window.showErrorMessage(`DB Copilot: ${message}`);
    }
  };
}

async function pickOrg(
  client: ApiClient,
  selectedOrgId: string | null,
  selectedOrgName: string | null
): Promise<OrgPickItem | null> {
  const orgs = await listOrgs(client);
  const items: OrgPickItem[] = [
    {
      label: "Personal workspace",
      description: "Personal",
      orgId: null,
      picked: selectedOrgName === "Personal workspace" || selectedOrgId === null,
    },
    ...orgs.map((org) => ({
      label: org.name,
      description: org.role ?? undefined,
      orgId: org.id,
      picked: selectedOrgId === org.id,
    })),
  ];

  return (
    (await vscode.window.showQuickPick(items, {
      placeHolder: "Select Org",
      ignoreFocusOut: true,
    })) ?? null
  );
}

async function pickProject(
  client: ApiClient,
  orgId: string | null,
  orgName: string,
  selectedProjectId: string | null
): Promise<ProjectPickItem | null> {
  const projects = await listProjects(client);
  const filtered = projects.filter((project) =>
    orgId ? project.org_id === orgId : project.org_id === null
  );
  if (filtered.length === 0) {
    vscode.window.showInformationMessage(`DB Copilot: No projects available for ${orgName}.`);
    return null;
  }

  const items: ProjectPickItem[] = filtered.map((project) => ({
    label: project.name,
    description: orgName,
    projectId: project.id,
    picked: selectedProjectId === project.id,
  }));

  return (
    (await vscode.window.showQuickPick(items, {
      placeHolder: "Select Project",
      ignoreFocusOut: true,
    })) ?? null
  );
}

async function pickEnvironment(
  client: ApiClient,
  projectId: string,
  selectedEnvId: string | null
): Promise<EnvPickItem | null> {
  const connections = await listConnections(client, projectId);
  if (connections.length === 0) {
    vscode.window.showInformationMessage("DB Copilot: No environments available.");
    return null;
  }

  const items: EnvPickItem[] = connections.map((connection) => ({
    label: connection.name,
    description: buildEnvDescription(connection),
    detail: connection.type,
    envId: connection.id,
    envName: connection.name,
    picked: selectedEnvId === connection.id,
  }));

  return (
    (await vscode.window.showQuickPick(items, {
      placeHolder: "Select Environment",
      ignoreFocusOut: true,
    })) ?? null
  );
}

function buildEnvDescription(connection: ConnectionResource): string | undefined {
  const host = connection.host ?? "";
  const port = connection.port ? `:${connection.port}` : "";
  const database = connection.database ?? "";
  const value = `${host}${port}${database ? `/${database}` : ""}`.trim();
  return value || undefined;
}
