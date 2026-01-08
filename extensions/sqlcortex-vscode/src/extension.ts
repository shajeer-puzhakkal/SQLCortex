import * as vscode from "vscode";
import { createApiClient, formatApiError } from "./api/client";
import {
  executeQuery,
  listConnections,
  listOrgs,
  listProjects,
} from "./api/endpoints";
import type { ConnectionResource, Org, Project } from "./api/types";
import {
  clearCachedSession,
  requireAuth,
  setCachedSession,
  verifyToken,
  type SessionSnapshot,
} from "./auth/session";
import { createTokenStore } from "./auth/tokenStore";
import {
  clearActiveProject,
  clearActiveConnection,
  clearWorkspaceContext,
  getWorkspaceContext,
  setActiveOrg,
  setActiveConnection,
  setActiveProject,
} from "./state/workspaceState";
import { createStatusBarItems, updateStatusBar, type StatusBarItems } from "./ui/statusBar";
import { ResultsPanel } from "./ui/resultsPanel";
import { ChatViewProvider } from "./ui/chatView";
import { DbExplorerProvider } from "./ui/tree/dbExplorerProvider";
import { ColumnNode, SchemaNode, TableNode } from "./ui/tree/nodes";
import { SidebarProvider } from "./ui/tree/sidebarProvider";
import { SqlCompletionProvider } from "./sql/completions";
import { extractSql, type ExtractMode } from "./sql/extractor";
import { validateReadOnlySql } from "./sql/validator";

const COMMANDS: Array<{ id: string; label: string }> = [
  { id: "sqlcortex.login", label: "Login" },
  { id: "sqlcortex.logout", label: "Logout" },
  { id: "sqlcortex.selectOrg", label: "Select Org" },
  { id: "sqlcortex.selectProject", label: "Select Project" },
  { id: "sqlcortex.selectConnection", label: "Select Connection" },
  { id: "sqlcortex.refreshExplorer", label: "Refresh Explorer" },
  { id: "sqlcortex.searchTable", label: "Search Table" },
  { id: "sqlcortex.copyTableName", label: "Copy Table Name" },
  { id: "sqlcortex.copyColumnName", label: "Copy Column Name" },
  { id: "sqlcortex.runTableQuery", label: "Run Table Query" },
  { id: "sqlcortex.runQuery", label: "Run Query" },
  { id: "sqlcortex.runSelection", label: "Run Selection" },
];

const API_BASE_URL_KEY = "sqlcortex.apiBaseUrl";
const CONTEXT_IS_AUTHED = "sqlcortex.isAuthed";
const CONTEXT_HAS_PROJECT = "sqlcortex.hasProject";
const DEFAULT_API_BASE_URL = "http://localhost:4000";
const LEGACY_API_BASE_URL = "http://localhost:3000";
const PERSONAL_ORG_LABEL = "Personal workspace";

type OrgPickItem = vscode.QuickPickItem & { orgId: string | null };
type ProjectPickItem = vscode.QuickPickItem & { projectId: string };
type ConnectionPickItem = vscode.QuickPickItem & { connectionId: string };
type SchemaPickItem = vscode.QuickPickItem & { schemaName: string };
type TablePickItem = vscode.QuickPickItem & {
  schemaName: string;
  tableName: string;
  tableType: "table" | "view";
};

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("SQLCortex");
  output.appendLine("SQLCortex extension activated.");
  context.subscriptions.push(output);

  void migrateApiBaseUrl(context, output);

  ResultsPanel.register(context);

  const tokenStore = createTokenStore(context.secrets);
  const statusBars = createStatusBarItems();
  context.subscriptions.push(
    statusBars.workspace,
    statusBars.connection,
    statusBars.runQuery
  );

  const sidebarProvider = new SidebarProvider({ context, tokenStore });
  const sidebarView = vscode.window.createTreeView("sqlcortex.overview", {
    treeDataProvider: sidebarProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(sidebarView);

  void refreshContext(context, tokenStore, statusBars, sidebarProvider);

  const dbExplorerProvider = new DbExplorerProvider({
    context,
    tokenStore,
    output,
    resolveAuthContext: () => resolveAuthContext(context, tokenStore, output),
    createAuthorizedClient: (auth) =>
      createAuthorizedClient(context, auth, tokenStore, output, statusBars, sidebarProvider),
  });
  const dbExplorerView = vscode.window.createTreeView("sqlcortex.databaseExplorer", {
    treeDataProvider: dbExplorerProvider,
    showCollapseAll: true,
  });
  dbExplorerProvider.attachView(dbExplorerView);
  context.subscriptions.push(dbExplorerView);

  const chatViewProvider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "sqlcortex.chatView",
      chatViewProvider,
      { retainContextWhenHidden: true }
    )
  );

  const sqlCompletionProvider = new SqlCompletionProvider({
    context,
    output,
    resolveAuthContext: () => resolveAuthContextSilently(context, tokenStore),
    createClient: (auth) =>
      createApiClient({
        baseUrl: auth.baseUrl,
        token: auth.token,
        clientHeader: clientHeader(context),
      }),
  });
  const completionDisposable = vscode.languages.registerCompletionItemProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "sql", scheme: "untitled" },
      { language: "plaintext", scheme: "untitled" },
    ],
    sqlCompletionProvider,
    "."
  );
  context.subscriptions.push(completionDisposable);

  const handlers: Record<string, (...args: unknown[]) => Thenable<unknown>> = {
    "sqlcortex.login": async () => {
      const didLogin = await loginFlow(context, tokenStore, output);
      await refreshContext(context, tokenStore, statusBars, sidebarProvider);
      dbExplorerProvider.refresh();
      return didLogin;
    },
    "sqlcortex.logout": async () => {
      const didLogout = await logoutFlow(context, tokenStore, output, dbExplorerProvider);
      await refreshContext(context, tokenStore, statusBars, sidebarProvider);
      return didLogout;
    },
    "sqlcortex.selectOrg": async () => {
      await selectOrgFlow(
        context,
        tokenStore,
        output,
        statusBars,
        dbExplorerProvider,
        sidebarProvider
      );
    },
    "sqlcortex.selectProject": async () => {
      await selectProjectFlow(
        context,
        tokenStore,
        output,
        statusBars,
        dbExplorerProvider,
        sidebarProvider
      );
    },
    "sqlcortex.selectConnection": async () => {
      await selectConnectionFlow(
        context,
        tokenStore,
        output,
        statusBars,
        dbExplorerProvider,
        sidebarProvider
      );
    },
    "sqlcortex.refreshExplorer": async () => {
      dbExplorerProvider.clearCache();
      dbExplorerProvider.refresh();
    },
    "sqlcortex.searchTable": async (...args) => {
      await searchTableFlow(
        context,
        tokenStore,
        output,
        statusBars,
        dbExplorerProvider,
        sidebarProvider,
        args[0]
      );
    },
    "sqlcortex.copyTableName": async (...args) => {
      const node = args[0];
      await copyTableNameFlow(node);
    },
    "sqlcortex.copyColumnName": async (...args) => {
      const node = args[0];
      await copyColumnNameFlow(node);
    },
    "sqlcortex.runTableQuery": async (...args) => {
      await runTableQueryFlow(
        context,
        tokenStore,
        output,
        statusBars,
        sidebarProvider,
        args[0]
      );
    },
    "sqlcortex.runQuery": async () => {
      await runQueryFlow(context, tokenStore, output, statusBars, sidebarProvider);
    },
    "sqlcortex.runSelection": async () => {
      await runSelectionFlow(context, tokenStore, output, statusBars, sidebarProvider);
    },
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

async function refreshContext(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  const token = await tokenStore.getAccessToken();
  const isAuthed = Boolean(token);
  await vscode.commands.executeCommand("setContext", CONTEXT_IS_AUTHED, isAuthed);

  const workspaceContext = getWorkspaceContext(context);
  await vscode.commands.executeCommand(
    "setContext",
    CONTEXT_HAS_PROJECT,
    Boolean(workspaceContext.projectId)
  );
  updateStatusBar(statusBars, { isAuthed, ...workspaceContext });
  sidebarProvider?.refresh();
}

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
  output: vscode.OutputChannel,
  dbExplorerProvider?: DbExplorerProvider
): Promise<boolean> {
  await tokenStore.clear();
  clearCachedSession();
  await clearWorkspaceContext(context);
  dbExplorerProvider?.clearCache();
  dbExplorerProvider?.refresh();
  output.appendLine("SQLCortex: Logged out.");
  vscode.window.showInformationMessage("SQLCortex: Logged out.");
  return true;
}

async function resolveAuthContext(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel
): Promise<{ baseUrl: string; token: string; session: SessionSnapshot } | null> {
  const baseUrl = await getOrPromptApiBaseUrl(context);
  if (!baseUrl) {
    return null;
  }

  try {
    const auth = await requireAuth({
      tokenStore,
      baseUrl,
      clientHeader: clientHeader(context),
      promptLogin: () => loginFlow(context, tokenStore, output),
    });
    if (!auth) {
      return null;
    }
    return { baseUrl, token: auth.token, session: auth.session };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      vscode.window.showErrorMessage(
        `SQLCortex: API not found at ${baseUrl}. Run Login to update the base URL.`
      );
    } else {
      vscode.window.showErrorMessage(`SQLCortex: ${formatRequestError(err)}`);
    }
    output.appendLine(`SQLCortex: Auth check failed: ${formatRequestError(err)}`);
    return null;
  }
}

async function resolveAuthContextSilently(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>
): Promise<{ baseUrl: string; token: string } | null> {
  const token = await tokenStore.getAccessToken();
  if (!token) {
    return null;
  }
  const baseUrl = context.globalState.get<string>(API_BASE_URL_KEY);
  if (!baseUrl) {
    return null;
  }
  return { baseUrl, token };
}

async function selectOrgFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  dbExplorerProvider?: DbExplorerProvider,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    return;
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  let orgs: Org[] = [];
  try {
    orgs = await listOrgs(client);
  } catch (err) {
    reportRequestError(output, "Failed to load orgs", err);
    return;
  }

  const workspaceContext = getWorkspaceContext(context);
  const orgItems: OrgPickItem[] = [];
  if (auth.session.user) {
    orgItems.push({
      label: PERSONAL_ORG_LABEL,
      description: "Personal",
      orgId: null,
      picked: workspaceContext.orgName === PERSONAL_ORG_LABEL,
    });
  }

  for (const org of orgs) {
    orgItems.push({
      label: org.name,
      description: formatOrgRole(org.role) ?? undefined,
      orgId: org.id,
      picked: workspaceContext.orgId === org.id,
    });
  }

  if (orgItems.length === 0) {
    vscode.window.showInformationMessage("SQLCortex: No orgs available.");
    return;
  }

  const selection = await vscode.window.showQuickPick(orgItems, {
    placeHolder: "Select SQLCortex org",
    ignoreFocusOut: true,
  });

  if (!selection) {
    return;
  }

  const previous = getWorkspaceContext(context);
  await setActiveOrg(context, selection.orgId, selection.label);
  const orgChanged =
    previous.orgId !== selection.orgId || previous.orgName !== selection.label;
  if (orgChanged) {
    await clearActiveProject(context);
    dbExplorerProvider?.clearCache();
    dbExplorerProvider?.refresh();
  }
  await refreshContext(context, tokenStore, statusBars, sidebarProvider);
}

async function selectProjectFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  dbExplorerProvider?: DbExplorerProvider,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    return;
  }

  let workspaceContext = getWorkspaceContext(context);
  if (!workspaceContext.orgName) {
    await selectOrgFlow(
      context,
      tokenStore,
      output,
      statusBars,
      dbExplorerProvider,
      sidebarProvider
    );
    workspaceContext = getWorkspaceContext(context);
    if (!workspaceContext.orgName) {
      return;
    }
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  let projects: Project[] = [];
  try {
    projects = await listProjects(client);
  } catch (err) {
    reportRequestError(output, "Failed to load projects", err);
    return;
  }

  const filtered = projects.filter((project) =>
    workspaceContext.orgId ? project.org_id === workspaceContext.orgId : project.org_id === null
  );
  if (filtered.length === 0) {
    vscode.window.showInformationMessage(
      `SQLCortex: No projects available for ${workspaceContext.orgName}.`
    );
    return;
  }

  const projectItems: ProjectPickItem[] = filtered.map((project) => ({
    label: project.name,
    description: workspaceContext.orgName ?? "Personal",
    projectId: project.id,
    picked: workspaceContext.projectId === project.id,
  }));

  const selection = await vscode.window.showQuickPick(projectItems, {
    placeHolder: "Select SQLCortex project",
    ignoreFocusOut: true,
  });

  if (!selection) {
    return;
  }

  const previous = getWorkspaceContext(context);
  await setActiveProject(context, selection.projectId, selection.label);
  if (previous.projectId !== selection.projectId) {
    await clearActiveConnection(context);
    dbExplorerProvider?.clearCache();
    dbExplorerProvider?.refresh();
  }
  await refreshContext(context, tokenStore, statusBars, sidebarProvider);
}

async function selectConnectionFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  dbExplorerProvider: DbExplorerProvider,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  let workspaceContext = getWorkspaceContext(context);
  if (!workspaceContext.projectId) {
    await selectProjectFlow(
      context,
      tokenStore,
      output,
      statusBars,
      dbExplorerProvider,
      sidebarProvider
    );
    workspaceContext = getWorkspaceContext(context);
    if (!workspaceContext.projectId) {
      return;
    }
  }

  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    return;
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  let connections: ConnectionResource[] = [];
  try {
    connections = await listConnections(client, workspaceContext.projectId);
  } catch (err) {
    reportRequestError(output, "Failed to load connections", err);
    return;
  }

  if (connections.length === 0) {
    vscode.window.showInformationMessage("SQLCortex: No connections available.");
    return;
  }

  const items: ConnectionPickItem[] = connections.map((connection) => {
    const descriptionParts = [connection.type, connection.database].filter(Boolean);
    const description =
      descriptionParts.length > 0 ? descriptionParts.join(" / ") : undefined;
    const detail =
      connection.host || connection.port
        ? `${connection.host ?? ""}${connection.port ? `:${connection.port}` : ""}`
        : undefined;
    return {
      label: connection.name,
      description,
      detail,
      connectionId: connection.id,
      picked: workspaceContext.connectionId === connection.id,
    };
  });

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: "Select SQLCortex connection",
    ignoreFocusOut: true,
  });

  if (!selection) {
    return;
  }

  const previous = getWorkspaceContext(context);
  await setActiveConnection(context, selection.connectionId, selection.label);
  if (previous.connectionId !== selection.connectionId) {
    dbExplorerProvider.clearCache();
  }
  dbExplorerProvider.refresh();
  await refreshContext(context, tokenStore, statusBars, sidebarProvider);
}

async function searchTableFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  dbExplorerProvider: DbExplorerProvider,
  sidebarProvider?: SidebarProvider,
  node?: unknown
): Promise<void> {
  let workspaceContext = getWorkspaceContext(context);
  if (!workspaceContext.projectId) {
    await selectProjectFlow(
      context,
      tokenStore,
      output,
      statusBars,
      dbExplorerProvider,
      sidebarProvider
    );
    workspaceContext = getWorkspaceContext(context);
    if (!workspaceContext.projectId) {
      return;
    }
  }

  if (!workspaceContext.connectionId) {
    await selectConnectionFlow(
      context,
      tokenStore,
      output,
      statusBars,
      dbExplorerProvider,
      sidebarProvider
    );
    workspaceContext = getWorkspaceContext(context);
    if (!workspaceContext.connectionId) {
      return;
    }
  }

  let schemaName: string | null = null;
  if (node instanceof SchemaNode) {
    schemaName = node.schemaName;
  } else if (node instanceof TableNode) {
    schemaName = node.schemaName;
  } else if (node instanceof ColumnNode) {
    schemaName = node.schemaName;
  }

  if (!schemaName) {
    const schemas = await dbExplorerProvider.getSchemasForSearch();
    if (!schemas) {
      return;
    }
    if (schemas.length === 0) {
      vscode.window.showInformationMessage("SQLCortex: No schemas available.");
      return;
    }
    const schemaItems: SchemaPickItem[] = schemas.map((schema) => ({
      label: schema.name,
      schemaName: schema.name,
    }));
    const schemaSelection = await vscode.window.showQuickPick(schemaItems, {
      placeHolder: "Select a schema to search",
      ignoreFocusOut: true,
    });
    if (!schemaSelection) {
      return;
    }
    schemaName = schemaSelection.schemaName;
  }

  const tables = await dbExplorerProvider.getTablesForSearch(schemaName);
  if (!tables) {
    return;
  }
  if (tables.length === 0) {
    vscode.window.showInformationMessage("SQLCortex: No tables or views found.");
    return;
  }

  const tableItems: TablePickItem[] = tables.map((table) => ({
    label: table.name,
    description: table.type === "view" ? "view" : "table",
    schemaName,
    tableName: table.name,
    tableType: table.type,
  }));

  const tableSelection = await vscode.window.showQuickPick(tableItems, {
    placeHolder: "Select a table or view",
    ignoreFocusOut: true,
  });

  if (!tableSelection) {
    return;
  }

  const fullName = `${tableSelection.schemaName}.${tableSelection.tableName}`;
  const revealed = await dbExplorerProvider.revealTable(
    tableSelection.schemaName,
    tableSelection.tableName,
    tableSelection.tableType
  );
  if (!revealed) {
    await vscode.env.clipboard.writeText(fullName);
    vscode.window.showInformationMessage(`SQLCortex: Copied ${fullName}`);
  } else {
    vscode.window.showInformationMessage(`SQLCortex: Revealed ${fullName}`);
  }
}

async function copyTableNameFlow(node?: unknown): Promise<void> {
  let schemaName: string | null = null;
  let tableName: string | null = null;

  if (node instanceof TableNode) {
    schemaName = node.schemaName;
    tableName = node.table.name;
  } else if (node instanceof ColumnNode) {
    schemaName = node.schemaName;
    tableName = node.tableName;
  }

  if (!schemaName || !tableName) {
    vscode.window.showInformationMessage("SQLCortex: Select a table to copy.");
    return;
  }

  const fullName = `${schemaName}.${tableName}`;
  await vscode.env.clipboard.writeText(fullName);
  vscode.window.showInformationMessage(`SQLCortex: Copied ${fullName}`);
}

async function copyColumnNameFlow(node?: unknown): Promise<void> {
  if (!(node instanceof ColumnNode)) {
    vscode.window.showInformationMessage("SQLCortex: Select a column to copy.");
    return;
  }
  await vscode.env.clipboard.writeText(node.column.name);
  vscode.window.showInformationMessage(`SQLCortex: Copied ${node.column.name}`);
}

async function runTableQueryFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  node?: unknown
): Promise<void> {
  if (!(node instanceof TableNode)) {
    vscode.window.showInformationMessage("SQLCortex: Select a table to run.");
    return;
  }

  const workspaceContext = await ensureActiveProject(
    context,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  if (!workspaceContext || !workspaceContext.projectId) {
    return;
  }
  if (!workspaceContext.connectionId) {
    vscode.window.showErrorMessage(
      "SQLCortex: Select a connection before running queries."
    );
    return;
  }

  const sql = buildTableSelectSql(node.schemaName, node.table.name);
  const document = await vscode.workspace.openTextDocument({
    language: "sql",
    content: sql,
  });
  await vscode.window.showTextDocument(document, { preview: false });
  await runQueryFlow(context, tokenStore, output, statusBars, sidebarProvider);
}

async function ensureActiveProject(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
) {
  let workspaceContext = getWorkspaceContext(context);
  if (!workspaceContext.projectId) {
    await selectProjectFlow(context, tokenStore, output, statusBars, undefined, sidebarProvider);
    workspaceContext = getWorkspaceContext(context);
  }
  if (!workspaceContext.projectId) {
    vscode.window.showErrorMessage("SQLCortex: Select a project before running queries.");
    return null;
  }
  return workspaceContext;
}

async function runQueryFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  await runSqlFlow("smart", context, tokenStore, output, statusBars, sidebarProvider);
}

async function runSelectionFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  await runSqlFlow("selection", context, tokenStore, output, statusBars, sidebarProvider);
}

async function runSqlFlow(
  mode: ExtractMode,
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    return;
  }

  const workspaceContext = await ensureActiveProject(
    context,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  if (!workspaceContext || !workspaceContext.projectId) {
    return;
  }
  if (!workspaceContext.connectionId) {
    vscode.window.showErrorMessage(
      "SQLCortex: Select a connection before running queries."
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("SQLCortex: Open a file to run SQL.");
    return;
  }

  const extracted = extractSql(editor, mode);
  if (!extracted.sql) {
    const message =
      extracted.source === "selection"
        ? "SQLCortex: Select SQL to run."
        : "SQLCortex: Current file is empty.";
    vscode.window.showWarningMessage(message);
    return;
  }

  const validation = validateReadOnlySql(extracted.sql);
  if (!validation.ok) {
    vscode.window.showErrorMessage(`SQLCortex: ${validation.reason}`);
    return;
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  const request = {
    projectId: workspaceContext.projectId,
    connectionId: workspaceContext.connectionId ?? undefined,
    sql: extracted.sql,
    source: "vscode" as const,
    client: {
      extensionVersion: getExtensionVersion(context),
      vscodeVersion: vscode.version,
    },
  };

  output.show(true);
  output.appendLine(
    `SQLCortex: Executing ${extracted.source} query (${extracted.sql.length} chars).`
  );

  try {
    const response = await executeQuery(client, request);
    if (response.error) {
      const errorMessage = response.error.message ?? "Query failed.";
      const errorReason = extractErrorReason(response.error.details);
      const detailMessage = errorReason ? `${errorMessage} (Reason: ${errorReason})` : errorMessage;
      output.appendLine(
        `SQLCortex: Query error (${response.error.code ?? "UNKNOWN"}): ${detailMessage}`
      );
      vscode.window.showErrorMessage(`SQLCortex: ${detailMessage}`);
      ResultsPanel.show(context).update({
        kind: "error",
        error: { message: detailMessage, code: response.error.code ?? undefined },
      });
      return;
    }

    output.appendLine(
      `SQLCortex: Query complete. ${response.rowsReturned} rows in ${response.executionTimeMs}ms.`
    );
    vscode.window.showInformationMessage(
      `SQLCortex: Returned ${response.rowsReturned} rows in ${response.executionTimeMs}ms.`
    );
    ResultsPanel.show(context).update({
      kind: "success",
      data: {
        queryId: response.queryId,
        executionTimeMs: response.executionTimeMs,
        rowsReturned: response.rowsReturned,
        columns: response.columns,
        rows: response.rows,
      },
    });
  } catch (err) {
    ResultsPanel.show(context).update({
      kind: "error",
      error: { message: formatRequestError(err) },
    });
    reportRequestError(output, "Query failed", err);
  }
}

function createAuthorizedClient(
  context: vscode.ExtensionContext,
  auth: { baseUrl: string; token: string },
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
) {
  return createApiClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
    clientHeader: clientHeader(context),
    onUnauthorized: () =>
      handleUnauthorized(context, tokenStore, output, statusBars, sidebarProvider),
  });
}

async function handleUnauthorized(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  await tokenStore.clear();
  clearCachedSession();
  await refreshContext(context, tokenStore, statusBars, sidebarProvider);
  output.appendLine("SQLCortex: Session expired. Please log in again.");
  const choice = await vscode.window.showErrorMessage(
    "SQLCortex: Session expired. Please log in again.",
    "Login"
  );
  if (choice === "Login") {
    await loginFlow(context, tokenStore, output);
    await refreshContext(context, tokenStore, statusBars, sidebarProvider);
  }
}

function formatOrgRole(role: string | null | undefined): string | null {
  if (!role) {
    return null;
  }
  const normalized = role.toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatRequestError(err: unknown): string {
  return formatApiError(err);
}

function reportRequestError(output: vscode.OutputChannel, label: string, err: unknown): void {
  const message = formatRequestError(err);
  output.appendLine(`SQLCortex: ${label}: ${message}`);
  const status = (err as { status?: number }).status;
  if (status === 401) {
    return;
  }
  vscode.window.showErrorMessage(`SQLCortex: ${message}`);
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
  return `vscode/${getExtensionVersion(context)}`;
}

function formatError(err: unknown): string {
  return formatApiError(err);
}

function extractErrorReason(details?: Record<string, unknown>): string | null {
  if (!details) {
    return null;
  }
  const reason = details.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function buildTableSelectSql(schemaName: string, tableName: string): string {
  return `SELECT * FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  return typeof version === "string" ? version : "0.0.0";
}
