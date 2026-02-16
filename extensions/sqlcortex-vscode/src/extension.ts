import { createHash } from "crypto";
import * as vscode from "vscode";
import { createApiClient, formatApiError } from "./api/client";
import {
  analyzeQuery,
  askQueryInsightsChat,
  getBillingPlan,
  getSchemaInsights,
  executeQuery,
  getSchemaMetadata,
  listConnections,
  listOrgs,
  listProjects,
} from "./api/endpoints";
import type {
  AnalyzeRequest,
  AiSuggestion,
  ConnectionResource,
  ExplainMode,
  ForeignKeyInfo,
  IndexInfo,
  Org,
  Project,
  RuleFinding,
  SchemaColumnResource,
  SchemaMetadataResponse,
  TableInfo,
} from "./api/types";
import { estimateCredits } from "../../../packages/shared/src/credits";
import { hashSql, normalizeSql as normalizeSqlForHash } from "../../../packages/shared/src/sql";
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
import {
  createDbCopilotStatusBarItems,
  updateDbCopilotStatusBar,
  type DbCopilotStatusBarItems,
} from "./ui/dbCopilotStatusBar";
import { ResultsPanel } from "./ui/resultsPanel";
import {
  DbCopilotLogsView,
  DbCopilotRiskImpactView,
  DbCopilotSqlPreviewView,
} from "./ui/dbCopilotBottomPanel";
import { DbCopilotAgentLogsPanel } from "./ui/dbCopilotAgentLogs";
import { QueryInsightsView } from "./ui/queryInsightsView";
import { ChatViewProvider } from "./ui/chatView";
import { AgentViewProvider } from "./ui/agentView";
import type { AgentChatContext, AgentChatMessage } from "./ui/agentView";
import { AnalyzeCodeLensProvider } from "./ui/analyzeCodeLens";
import { DbExplorerProvider, type TableConstraintInfo } from "./ui/tree/dbExplorerProvider";
import { ColumnNode, SchemaNode, TableNode } from "./ui/tree/nodes";
import { SidebarProvider } from "./ui/tree/sidebarProvider";
import { DbCopilotPlaceholderProvider } from "./ui/tree/dbCopilotPlaceholderProvider";
import { DbCopilotSchemaNode } from "./ui/tree/dbCopilotNodes";
import { SchemaTreeProvider } from "./views/schema/SchemaTreeProvider";
import { buildDbCopilotErdHtml } from "./ui/dbCopilotErdPanel";
import { buildDbCopilotMigrationPlanHtml } from "./ui/dbCopilotMigrationPlan";
import { buildDbCopilotOptimizationPlanHtml } from "./ui/dbCopilotOptimizationPlan";
import { SqlCompletionProvider } from "./sql/completions";
import { extractSql, type ExtractMode } from "./sql/extractor";
import { createSqlDiagnosticsCollection, updateSqlDiagnostics } from "./sql/diagnostics";
import { validateReadOnlySql } from "./sql/validator";
import {
  analyzeSchemaMetadata,
  analyzeTableMetadata,
  buildSchemaErdHtml,
} from "./schema/schemaAnalysis";
import {
  type DbCopilotSchemaSnapshot,
  type DbCopilotSchemaSnapshots,
} from "./dbcopilot/schemaSnapshot";
import {
  buildDbCopilotOptimizationPlan,
  resolveDbCopilotDbEngine,
  resolveDbCopilotPolicies,
  type DbCopilotOptimizationPlan,
} from "./dbcopilot/orchestrator";
import {
  buildDbCopilotMigrationPlan,
  buildDbCopilotMigrationSqlExport,
  buildDbCopilotMigrationTopRisks,
  evaluateDbCopilotMigrationExecutionGate,
  splitSqlStatements,
  type DbCopilotMigrationPlan,
} from "./dbcopilot/migrationPlan";
import type {
  DbCopilotAuditLogEntry,
  DbCopilotLogEntry,
  DbCopilotRiskImpactState,
  DbCopilotSqlPreviewState,
} from "./dbcopilot/bottomPanelState";
import {
  getDbCopilotState,
  setDbCopilotConnection,
  setDbCopilotMode,
  setDbCopilotSchemaSnapshot,
  setDbCopilotSchemaSnapshotStatus,
  getDbCopilotSchemaSnapshot,
  getDbCopilotSchemaSnapshots,
  setDbCopilotSchemaSnapshots,
  type DbCopilotMode,
} from "./state/dbCopilotState";
import { ConnectionManager } from "./core/connection/ConnectionManager";
import { ConnectionProfileStore } from "./core/connection/ConnectionProfileStore";
import type { ConnectionProfile, ConnectionState } from "./core/connection/ConnectionTypes";
import { LogBus } from "./core/logging/LogBus";
import { createConnectDatabaseCommand } from "./commands/connectDatabase";
import { createDisconnectDatabaseCommand } from "./commands/disconnectDatabase";
import { ApiSessionManager } from "./core/auth/ApiSessionManager";
import { TargetStore, type SelectedTarget } from "./core/target/TargetStore";
import { SchemaRefreshScheduler } from "./core/schema/SchemaRefreshScheduler";
import { SchemaApi } from "./core/schema/SchemaApi";
import type { SchemaSnapshot } from "./core/schema/SchemaTypes";
import { createLoginWithTokenCommand } from "./commands/loginWithToken";
import { createLogoutCommand } from "./commands/logout";
import { createSelectTargetCommand } from "./commands/selectTarget";
import {
  createTargetStatusBarItem,
  updateTargetStatusBar,
} from "./ui/statusbar/TargetStatusBar";

const COMMANDS: Array<{ id: string; label: string }> = [
  { id: "sqlcortex.login", label: "Login" },
  { id: "sqlcortex.logout", label: "Logout" },
  { id: "sqlcortex.selectOrg", label: "Select Org" },
  { id: "sqlcortex.selectProject", label: "Select Project" },
  { id: "sqlcortex.selectConnection", label: "Select Connection" },
  { id: "sqlcortex.setExplainMode", label: "Set EXPLAIN Mode" },
  { id: "sqlcortex.refreshExplorer", label: "Refresh Explorer" },
  { id: "sqlcortex.searchTable", label: "Search Table" },
  { id: "sqlcortex.copyTableName", label: "Copy Table Name" },
  { id: "sqlcortex.copyColumnName", label: "Copy Column Name" },
  { id: "sqlcortex.runTableQuery", label: "Run Table Query" },
  { id: "sqlcortex.runQuery", label: "Run Query" },
  { id: "sqlcortex.runSelection", label: "Run Selection" },
  { id: "sqlcortex.analyzeSelection", label: "Analyze Selection" },
  { id: "sqlcortex.analyzeSelectionWithAnalyze", label: "Analyze Selection (EXPLAIN ANALYZE)" },
  { id: "sqlcortex.analyzeDocument", label: "Analyze Query" },
  { id: "sqlcortex.analyzeDocumentWithAnalyze", label: "Analyze Query (EXPLAIN ANALYZE)" },
  { id: "sqlcortex.analyzeSchema", label: "Analyze Schema" },
  { id: "sqlcortex.analyzeTable", label: "Analyze Table" },
  { id: "sqlcortex.drawSchemaErd", label: "Draw ERD Diagram" },
];

const DBCOPILOT_COMMANDS: Array<{ id: string; label: string }> = [
  { id: "dbcopilot.loginWithToken", label: "Login with Token" },
  { id: "dbcopilot.logout", label: "Logout" },
  { id: "dbcopilot.selectTarget", label: "Select Target" },
  { id: "dbcopilot.connectDatabase", label: "Connect to Database" },
  { id: "dbcopilot.disconnectDatabase", label: "Disconnect Database" },
  { id: "dbcopilot.refreshSchema", label: "Refresh Schema" },
  { id: "dbcopilot.captureSchemaSnapshot", label: "Capture Schema Snapshot" },
  { id: "dbcopilot.optimizeCurrentQuery", label: "Optimize Current Query" },
  { id: "dbcopilot.analyzeSchemaHealth", label: "Analyze Schema Health" },
  { id: "dbcopilot.createTableWizard", label: "Create Table (Wizard)" },
  { id: "dbcopilot.openOptimizationPlan", label: "Open Optimization Plan" },
  { id: "dbcopilot.openErdDiagram", label: "Open ER Diagram" },
  { id: "dbcopilot.openMigrationPlan", label: "Open Migration Plan" },
  { id: "dbcopilot.saveMigration", label: "Save Migration" },
  { id: "dbcopilot.executeMigration", label: "Execute Migration" },
  { id: "dbcopilot.toggleMode", label: "Toggle Mode" },
  { id: "dbcopilot.viewPolicies", label: "View Policies" },
  { id: "dbcopilot.openAgentLogs", label: "Open Agent Logs" },
];

const DBCOPILOT_POLICY_NOTES = [
  "Execution mode requires explicit confirmation before applying changes.",
];

const API_BASE_URL_KEY = "sqlcortex.apiBaseUrl";
const CONTEXT_IS_AUTHED = "sqlcortex.isAuthed";
const CONTEXT_HAS_PROJECT = "sqlcortex.hasProject";
const DEFAULT_API_BASE_URL = "http://localhost:4000";
const LEGACY_API_BASE_URL = "http://localhost:3000";
const PERSONAL_ORG_LABEL = "Personal workspace";
const EXPLAIN_MODE_SETTING = "explain.mode";
const LEGACY_EXPLAIN_MODE_SETTING = "explainMode";
const EXPLAIN_ALLOW_ANALYZE_SETTING = "explain.allowAnalyze";
const GRACE_CREDITS = 20;
const CREDIT_MODEL_TIER = "standard" as const;
const MAX_SQL_LENGTH_SETTING = "maxSqlLength";
const DIAGNOSTICS_ENABLED_SETTING = "diagnostics.enabled";
const DEFAULT_MAX_SQL_LENGTH = 20000;
const EXPLAIN_ANALYZE_WARNING = "May execute query; use only on safe environments.";
const AI_LIMIT_MESSAGE =
  "You have reached today's AI limit. Upgrade to Pro for uninterrupted usage.";
const CREDIT_WARNING_MESSAGE = "You are getting strong value from SQLCortex";
const CREDIT_CRITICAL_MESSAGE = "Avoid interruptions - upgrade to Pro";
let schemaErdPanel: vscode.WebviewPanel | undefined;
let dbCopilotErdPanel: vscode.WebviewPanel | undefined;
let dbCopilotMigrationPlanPanel: vscode.WebviewPanel | undefined;
let dbCopilotErdSnapshot: DbCopilotSchemaSnapshot | null = null;
let dbCopilotSqlPreviewView: DbCopilotSqlPreviewView | undefined;
let dbCopilotRiskImpactView: DbCopilotRiskImpactView | undefined;
let dbCopilotLogsView: DbCopilotLogsView | undefined;
let dbCopilotSqlPreviewState: DbCopilotSqlPreviewState | null = null;
let dbCopilotRiskImpactState: DbCopilotRiskImpactState | null = null;
let dbCopilotOptimizationPlan: DbCopilotOptimizationPlan | null = null;
let dbCopilotLogEntries: DbCopilotLogEntry[] = [];
let dbCopilotLogStreamId = 0;
let dbCopilotAuditLogEntries: DbCopilotAuditLogEntry[] = [];
let dbCopilotAgentLogsPanel: DbCopilotAgentLogsPanel | undefined;
let dbCopilotAuditLogSessionId: string | null = null;
let dbCopilotSchemaRefreshScheduler: SchemaRefreshScheduler | null = null;

type OrgPickItem = vscode.QuickPickItem & { orgId: string | null };
type ProjectPickItem = vscode.QuickPickItem & { projectId: string };
type ConnectionPickItem = vscode.QuickPickItem & { connectionId: string };
type SchemaPickItem = vscode.QuickPickItem & { schemaName: string };
type TablePickItem = vscode.QuickPickItem & {
  schemaName: string;
  tableName: string;
  tableType: "table" | "view";
};

type InsightsChatContext = {
  sql: string;
  explainJson: unknown;
  projectId: string;
  connectionId: string;
};

type InsightsChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("SQLCortex");
  output.appendLine("SQLCortex extension activated.");
  context.subscriptions.push(output);

  void migrateApiBaseUrl(context, output);

  ResultsPanel.register(context);
  dbCopilotSqlPreviewView = DbCopilotSqlPreviewView.register(context);
  dbCopilotRiskImpactView = DbCopilotRiskImpactView.register(context);
  dbCopilotLogsView = DbCopilotLogsView.register(context);
  dbCopilotSqlPreviewView.update(dbCopilotSqlPreviewState);
  dbCopilotRiskImpactView.update(dbCopilotRiskImpactState);
  dbCopilotLogsView.setEntries(dbCopilotLogEntries);
  const queryInsightsView = QueryInsightsView.register(context);
  QueryInsightsView.show(context);
  const agentView = AgentViewProvider.register(context);
  AgentViewProvider.show(context);

  const diagnostics = createSqlDiagnosticsCollection();
  context.subscriptions.push(diagnostics);

  const tokenStore = createTokenStore(context.secrets);
  const statusBars = createStatusBarItems();
  const dbCopilotStatusBars = createDbCopilotStatusBarItems();
  const targetStatusBar = createTargetStatusBarItem();
  context.subscriptions.push(
    statusBars.workspace,
    statusBars.connection,
    statusBars.runQuery
  );
  context.subscriptions.push(
    dbCopilotStatusBars.db,
    dbCopilotStatusBars.mode,
    dbCopilotStatusBars.policies
  );
  context.subscriptions.push(targetStatusBar);
  const logBus = new LogBus();
  const targetStore = new TargetStore(context);
  const sessionManager = new ApiSessionManager({
    context,
    resolveBaseUrl: () => resolveApiBaseUrlFromState(context),
    clientHeader: clientHeader(context),
  });
  const connectionProfileStore = new ConnectionProfileStore(context);
  const connectionManager = new ConnectionManager({
    profileStore: connectionProfileStore,
    logBus,
  });
  context.subscriptions.push(logBus, connectionManager);
  context.subscriptions.push(
    logBus.onDidLog((entry) => {
      appendDbCopilotLogEntry(entry);
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`sqlcortex.${DIAGNOSTICS_ENABLED_SETTING}`)) {
        const config = vscode.workspace.getConfiguration("sqlcortex");
        if (!resolveDiagnosticsEnabled(config)) {
          diagnostics.clear();
        }
      }
    })
  );

  const sidebarProvider = new SidebarProvider({ context, tokenStore });
  const sidebarView = vscode.window.createTreeView("sqlcortex.overview", {
    treeDataProvider: sidebarProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(sidebarView);

  const dbCopilotOverviewProvider = new DbCopilotPlaceholderProvider({
    context,
    viewTitle: "Overview",
  });
  const dbCopilotAgentsProvider = new DbCopilotPlaceholderProvider({
    context,
    viewTitle: "Agents",
  });
  const dbCopilotSchemaProvider = new SchemaTreeProvider({
    context,
    sessionManager,
    targetStore,
  });
  const dbCopilotRecommendationsProvider = new DbCopilotPlaceholderProvider({
    context,
    viewTitle: "Recommendations",
  });
  const dbCopilotMigrationsProvider = new DbCopilotPlaceholderProvider({
    context,
    viewTitle: "Migrations",
  });
  const dbCopilotProviders = [
    dbCopilotOverviewProvider,
    dbCopilotAgentsProvider,
    dbCopilotSchemaProvider,
    dbCopilotRecommendationsProvider,
    dbCopilotMigrationsProvider,
  ];
  const schemaRefreshScheduler = new SchemaRefreshScheduler({
    debounceMs: 1000,
    refresh: async () => {
      if (!getDbCopilotState(context).connectionLabel || !targetStore.getSelectedTarget()) {
        return;
      }
      await syncDbCopilotSchemaSnapshot(
        context,
        sessionManager,
        targetStore,
        dbCopilotStatusBars,
        dbCopilotProviders
      );
    },
    onError: (err) => {
      logBus.error("Schema auto-refresh failed.", err);
    },
  });
  dbCopilotSchemaRefreshScheduler = schemaRefreshScheduler;
  context.subscriptions.push(
    schemaRefreshScheduler,
    new vscode.Disposable(() => {
      if (dbCopilotSchemaRefreshScheduler === schemaRefreshScheduler) {
        dbCopilotSchemaRefreshScheduler = null;
      }
    })
  );
  const dbCopilotViews = [
    vscode.window.createTreeView("dbcopilot.overview", {
      treeDataProvider: dbCopilotOverviewProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView("dbcopilot.agents", {
      treeDataProvider: dbCopilotAgentsProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView("dbcopilot.schema", {
      treeDataProvider: dbCopilotSchemaProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView("dbcopilot.recommendations", {
      treeDataProvider: dbCopilotRecommendationsProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView("dbcopilot.migrations", {
      treeDataProvider: dbCopilotMigrationsProvider,
      showCollapseAll: false,
    }),
  ];
  context.subscriptions.push(...dbCopilotViews);
  context.subscriptions.push(
    connectionManager.onDidChangeConnectionState((state) => {
      void syncDbCopilotConnectionState(
        context,
        state,
        dbCopilotStatusBars,
        dbCopilotProviders
      );
    })
  );

  queryInsightsView.setChatHandler((input) =>
    handleQueryInsightsChat(
      context,
      tokenStore,
      output,
      statusBars,
      sidebarProvider,
      input
    )
  );
  agentView.setChatHandler((input) =>
    handleAgentChat(
      context,
      tokenStore,
      output,
      statusBars,
      sidebarProvider,
      input
    )
  );

  void refreshContext(context, tokenStore, statusBars, sidebarProvider);
  void syncDbCopilotConnectionState(
    context,
    { status: "disconnected", profile: null },
    dbCopilotStatusBars,
    dbCopilotProviders
  );
  void syncDbCopilotTargetStatusBar(sessionManager, targetStore, targetStatusBar);

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
  void restoreDbCopilotTargetIfAvailable(
    context,
    sessionManager,
    targetStore,
    tokenStore,
    statusBars,
    sidebarProvider,
    dbExplorerProvider,
    dbCopilotStatusBars,
    dbCopilotProviders,
    targetStatusBar
  );

  const chatViewProvider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "sqlcortex.chatView",
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
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

  const codeLensProvider = new AnalyzeCodeLensProvider();
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "sql", scheme: "untitled" },
      { language: "pgsql", scheme: "file" },
      { language: "pgsql", scheme: "untitled" },
      { language: "mssql", scheme: "file" },
      { language: "mssql", scheme: "untitled" },
    ],
    codeLensProvider
  );
  context.subscriptions.push(codeLensDisposable);

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
    "sqlcortex.setExplainMode": async () => {
      await setExplainModeFlow();
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
    "sqlcortex.analyzeSelection": async () => {
      await analyzeSelectionFlow(context, tokenStore, output, statusBars, sidebarProvider, {
        diagnostics,
      });
    },
    "sqlcortex.analyzeSelectionWithAnalyze": async () => {
      await analyzeSelectionFlow(context, tokenStore, output, statusBars, sidebarProvider, {
        diagnostics,
        forcedMode: "EXPLAIN_ANALYZE",
      });
    },
    "sqlcortex.analyzeDocument": async () => {
      await analyzeSelectionFlow(context, tokenStore, output, statusBars, sidebarProvider, {
        diagnostics,
        mode: "smart",
      });
    },
    "sqlcortex.analyzeDocumentWithAnalyze": async () => {
      await analyzeSelectionFlow(context, tokenStore, output, statusBars, sidebarProvider, {
        diagnostics,
        mode: "smart",
        forcedMode: "EXPLAIN_ANALYZE",
      });
    },
    "sqlcortex.analyzeSchema": async (...args) => {
      await analyzeSchemaFlow(
        context,
        tokenStore,
        output,
        statusBars,
        sidebarProvider,
        dbExplorerProvider,
        args[0]
      );
    },
    "sqlcortex.analyzeTable": async (...args) => {
      await analyzeSchemaFlow(
        context,
        tokenStore,
        output,
        statusBars,
        sidebarProvider,
        dbExplorerProvider,
        args[0]
      );
    },
    "sqlcortex.drawSchemaErd": async (...args) => {
      await drawSchemaErdFlow(
        context,
        tokenStore,
        output,
        statusBars,
        sidebarProvider,
        dbExplorerProvider,
        args[0]
      );
    },
  };

  const dbCopilotHandlers: Record<string, (...args: unknown[]) => Thenable<unknown>> =
    {
      "dbcopilot.loginWithToken": createLoginWithTokenCommand({
        sessionManager,
        logBus,
        onDidLogin: async () => {
          await syncDbCopilotTargetStatusBar(sessionManager, targetStore, targetStatusBar);
        },
      }),
      "dbcopilot.logout": createLogoutCommand({
        sessionManager,
        targetStore,
        logBus,
        onDidLogout: async () => {
          await clearWorkspaceContext(context);
          await setDbCopilotConnection(context, null, null, null);
          await setDbCopilotSchemaSnapshot(context, false);
          await setDbCopilotSchemaSnapshots(context, null);
          resetDbCopilotBottomPanel();
          dbExplorerProvider.clearCache();
          dbExplorerProvider.refresh();
          await refreshContext(context, tokenStore, statusBars, sidebarProvider);
          await refreshDbCopilotUI(context, dbCopilotStatusBars, dbCopilotProviders);
          await syncDbCopilotTargetStatusBar(sessionManager, targetStore, targetStatusBar);
        },
      }),
      "dbcopilot.selectTarget": createSelectTargetCommand({
        sessionManager,
        targetStore,
        logBus,
        onTargetSelected: async (target) => {
          await applySelectedTarget(
            context,
            target,
            tokenStore,
            statusBars,
            sidebarProvider,
            dbExplorerProvider,
            dbCopilotStatusBars,
            dbCopilotProviders
          );
          await syncDbCopilotTargetStatusBar(sessionManager, targetStore, targetStatusBar);
        },
      }),
      "dbcopilot.connectDatabase": createConnectDatabaseCommand({
        connectionManager,
        profileStore: connectionProfileStore,
        logBus,
      }),
      "dbcopilot.disconnectDatabase": createDisconnectDatabaseCommand({
        connectionManager,
        logBus,
      }),
      "dbcopilot.refreshSchema": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        await syncDbCopilotSchemaSnapshot(
          context,
          sessionManager,
          targetStore,
          dbCopilotStatusBars,
          dbCopilotProviders,
          "DB Copilot: Schema refreshed."
        );
      },
      "dbcopilot.captureSchemaSnapshot": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        await syncDbCopilotSchemaSnapshot(
          context,
          sessionManager,
          targetStore,
          dbCopilotStatusBars,
          dbCopilotProviders,
          "DB Copilot: Schema snapshot captured."
        );
      },
      "dbcopilot.optimizeCurrentQuery": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        if (!(await ensureDbCopilotSnapshot(context))) {
          return;
        }
        const state = getDbCopilotState(context);
        const snapshot = resolveDbCopilotSnapshot(context, null);
        let activeSql = resolveDbCopilotActiveSqlText();
        const dbEngine = resolveDbCopilotDbEngine(state.connectionLabel ?? null);
        const policies = resolveDbCopilotPolicies(state.connectionLabel ?? null, dbEngine);
        let userRequest = activeSql
          ? `Optimize query:\n${activeSql}`
          : "Optimize current query";
        let plan = buildDbCopilotOptimizationPlan({
          user_request: userRequest,
          db_engine: dbEngine,
          connection_label: state.connectionLabel ?? null,
          schema_snapshot: snapshot,
          execution_mode: state.mode === "execution",
          policies,
          query_text: activeSql,
          explain_plan: null,
          now: new Date(),
        });
        if (plan.orchestrator.missing_context.includes("query_text")) {
          const manualSql = await vscode.window.showInputBox({
            prompt: "Paste the SQL to optimize",
            placeHolder: "SELECT ...",
            ignoreFocusOut: true,
          });
          if (manualSql && manualSql.trim()) {
            activeSql = manualSql.trim();
            userRequest = `Optimize query:\n${activeSql}`;
            plan = buildDbCopilotOptimizationPlan({
              user_request: userRequest,
              db_engine: dbEngine,
              connection_label: state.connectionLabel ?? null,
              schema_snapshot: snapshot,
              execution_mode: state.mode === "execution",
              policies,
              query_text: activeSql,
              explain_plan: null,
              now: new Date(),
            });
          }
        }
        dbCopilotOptimizationPlan = plan;
        setDbCopilotAuditLogs(plan);
        if (plan.orchestrator.missing_context.length) {
          setDbCopilotRiskImpactState(context, null);
          setDbCopilotSqlPreviewState(context, null);
          streamDbCopilotLogs(plan.logs);
          DbCopilotLogsView.show(context);
          vscode.window.showWarningMessage(
            `DB Copilot: Missing context (${plan.orchestrator.missing_context.join(", ")}).`
          );
          return;
        }
        if (plan.merged.risk_impact) {
          setDbCopilotRiskImpactState(context, plan.merged.risk_impact);
        }
        if (plan.merged.sql_preview) {
          setDbCopilotSqlPreviewState(context, plan.merged.sql_preview);
        }
        streamDbCopilotLogs(plan.logs);
        DbCopilotSqlPreviewView.show(context);
      },
      "dbcopilot.analyzeSchemaHealth": async (...args) => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        if (!(await ensureDbCopilotSnapshot(context))) {
          return;
        }
        const schemaName = resolveDbCopilotSchemaName(args[0]);
        openDbCopilotPlaceholderPanel("dbcopilot.analyzeSchemaHealth", {
          title: schemaName
            ? `Analyze Schema Health: ${schemaName}`
            : "Analyze Schema Health",
          description:
            "Schema health findings and recommendations will appear here.",
          bullets: [
            "Surface table bloat, missing indexes, and hot tables.",
            "Track schema drift and policy violations.",
          ],
        });
      },
      "dbcopilot.createTableWizard": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        openDbCopilotPlaceholderPanel("dbcopilot.createTableWizard", {
          title: "Create Table (Wizard)",
          description: "Table creation workflow will land in a later phase.",
          bullets: [
            "Define columns, constraints, and indexes.",
            "Preview generated SQL before execution.",
          ],
        });
      },
      "dbcopilot.openOptimizationPlan": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        if (!(await ensureDbCopilotSnapshot(context))) {
          return;
        }
        openDbCopilotOptimizationPlan(context, dbCopilotOptimizationPlan);
      },
      "dbcopilot.openErdDiagram": async (...args) => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        if (!(await ensureDbCopilotSnapshot(context))) {
          return;
        }
        const schemaName = resolveDbCopilotSchemaName(args[0]);
        const snapshot = resolveDbCopilotSnapshot(context, schemaName);
        if (!snapshot) {
          vscode.window.showErrorMessage(
            "DB Copilot: No schema snapshot data available for ER diagram."
          );
          return;
        }
        openDbCopilotErdDiagram(context, snapshot);
      },
      "dbcopilot.openMigrationPlan": async () => {
        if (!(await ensureDbCopilotConnected(context))) {
          return;
        }
        if (!(await ensureDbCopilotSnapshot(context))) {
          return;
        }
        openDbCopilotMigrationPlan(context, {
          tokenStore,
          output,
          statusBars,
          sidebarProvider,
        });
      },
      "dbcopilot.saveMigration": async () => {
        await saveDbCopilotMigrationArtifacts(context);
      },
      "dbcopilot.executeMigration": async () => {
        await executeDbCopilotMigrationPlan(
          context,
          tokenStore,
          output,
          statusBars,
          sidebarProvider
        );
      },
      "dbcopilot.toggleMode": async () => {
        await toggleDbCopilotMode(context, dbCopilotStatusBars, dbCopilotProviders);
      },
      "dbcopilot.viewPolicies": async () => {
        await openDbCopilotPolicies();
      },
      "dbcopilot.openAgentLogs": async () => {
        dbCopilotAgentLogsPanel = DbCopilotAgentLogsPanel.show();
        dbCopilotAgentLogsPanel.setEntries(dbCopilotAuditLogEntries);
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

  for (const command of DBCOPILOT_COMMANDS) {
    const handler =
      dbCopilotHandlers[command.id] ??
      (() => {
        output.appendLine(`Command executed: ${command.id}`);
        vscode.window.showInformationMessage(
          `DB Copilot: ${command.label} (not yet implemented)`
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

async function setExplainModeFlow(): Promise<void> {
  const config = vscode.workspace.getConfiguration("sqlcortex");
  const current = resolveExplainModeSetting(config);

  const picks = [
    {
      label: "EXPLAIN",
      description: "Default (does not execute query).",
      value: "EXPLAIN" as ExplainMode,
      picked: current === "EXPLAIN",
    },
    {
      label: "EXPLAIN ANALYZE",
      description: EXPLAIN_ANALYZE_WARNING,
      value: "EXPLAIN_ANALYZE" as ExplainMode,
      picked: current === "EXPLAIN_ANALYZE",
    },
  ];

  const selection = await vscode.window.showQuickPick(picks, {
    placeHolder: "Select EXPLAIN mode for analysis requests",
    ignoreFocusOut: true,
  });
  if (!selection) {
    return;
  }

  if (selection.value === "EXPLAIN_ANALYZE") {
    const allowAnalyze = resolveAllowAnalyze(config);
    if (!allowAnalyze) {
      const enable = await vscode.window.showWarningMessage(
        "EXPLAIN ANALYZE is disabled. Enable it to continue.",
        { modal: true },
        "Enable"
      );
      if (enable !== "Enable") {
        return;
      }
      await config.update(
        EXPLAIN_ALLOW_ANALYZE_SETTING,
        true,
        vscode.ConfigurationTarget.Global
      );
    }
    const confirm = await vscode.window.showWarningMessage(
      EXPLAIN_ANALYZE_WARNING,
      { modal: true },
      "Use EXPLAIN ANALYZE"
    );
    if (confirm !== "Use EXPLAIN ANALYZE") {
      return;
    }
  }

  if (selection.value === current) {
    return;
  }

  await config.update(EXPLAIN_MODE_SETTING, selection.value, vscode.ConfigurationTarget.Global);
  await config.update(
    LEGACY_EXPLAIN_MODE_SETTING,
    selection.value,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(`SQLCortex: EXPLAIN mode set to ${selection.label}.`);
}

function resolveExplainModeSetting(
  config: vscode.WorkspaceConfiguration
): ExplainMode {
  const configured =
    config.get<string>(EXPLAIN_MODE_SETTING) ??
    config.get<string>(LEGACY_EXPLAIN_MODE_SETTING);
  return configured === "EXPLAIN_ANALYZE" ? "EXPLAIN_ANALYZE" : "EXPLAIN";
}

function resolveAllowAnalyze(config: vscode.WorkspaceConfiguration): boolean {
  return config.get<boolean>(EXPLAIN_ALLOW_ANALYZE_SETTING) ?? false;
}

function resolveDiagnosticsEnabled(config: vscode.WorkspaceConfiguration): boolean {
  return config.get<boolean>(DIAGNOSTICS_ENABLED_SETTING) ?? false;
}

function resolveMaxSqlLength(config: vscode.WorkspaceConfiguration): number {
  const value = config.get<number>(MAX_SQL_LENGTH_SETTING);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_SQL_LENGTH;
}

async function confirmExplainAnalyze(
  config: vscode.WorkspaceConfiguration,
  mode: ExplainMode
): Promise<boolean> {
  if (mode !== "EXPLAIN_ANALYZE") {
    return true;
  }
  if (!resolveAllowAnalyze(config)) {
    const choice = await vscode.window.showWarningMessage(
      "EXPLAIN ANALYZE is disabled. Enable sqlcortex.explain.allowAnalyze to proceed.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "sqlcortex.explain.allowAnalyze"
      );
    }
    return false;
  }
  const confirm = await vscode.window.showWarningMessage(
    EXPLAIN_ANALYZE_WARNING,
    { modal: true },
    "Run"
  );
  return confirm === "Run";
}

function resolveWorkspaceIdHash(): string {
  const workspaceId =
    vscode.workspace.workspaceFile?.fsPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    "no-workspace";
  return createHash("sha256").update(workspaceId, "utf8").digest("hex");
}

function resolveOrgId(
  workspaceContext: ReturnType<typeof getWorkspaceContext>,
  session: SessionSnapshot
): string {
  return (
    workspaceContext.orgId ??
    session.org?.id ??
    session.user?.id ??
    "personal"
  );
}

function buildCreditNotice(plan: { softLimit90Reached: boolean; softLimit70Reached: boolean }): string | null {
  if (plan.softLimit90Reached) {
    return CREDIT_CRITICAL_MESSAGE;
  }
  if (plan.softLimit70Reached) {
    return CREDIT_WARNING_MESSAGE;
  }
  return null;
}

function resolveRemainingCredits(plan: {
  creditsRemaining: number | null;
  graceUsed: boolean | null;
}, estimatedCost: number): number {
  const remaining = plan.creditsRemaining ?? 0;
  if (remaining <= 0 && plan.graceUsed === false) {
    return Math.max(0, GRACE_CREDITS - estimatedCost);
  }
  return Math.max(0, remaining - estimatedCost);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeRuleFindings(value: unknown): RuleFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is RuleFinding => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as RuleFinding;
    return (
      typeof record.code === "string" &&
      typeof record.message === "string" &&
      typeof record.recommendation === "string" &&
      typeof record.rationale === "string"
    );
  });
}

function normalizeAiSuggestions(value: unknown): AiSuggestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is AiSuggestion => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as AiSuggestion;
    return (
      typeof record.title === "string" &&
      typeof record.description === "string" &&
      typeof record.confidence === "string"
    );
  });
}

function formatRuleFinding(finding: RuleFinding): string {
  const severity = finding.severity.toUpperCase();
  const parts = [finding.message];
  if (finding.recommendation) {
    parts.push(`Recommendation: ${finding.recommendation}`);
  }
  if (finding.rationale) {
    parts.push(`Rationale: ${finding.rationale}`);
  }
  return `[${severity}] ${parts.join(" ")}`;
}

function formatAiSuggestion(suggestion: AiSuggestion): string {
  const confidence = suggestion.confidence.toUpperCase();
  const tradeoffs =
    suggestion.tradeoffs && suggestion.tradeoffs.length > 0
      ? ` Tradeoffs: ${suggestion.tradeoffs.join(" ")}`
      : "";
  return `${suggestion.title} (${confidence}) — ${suggestion.description}${tradeoffs}`;
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

type AnalyzeSelectionOptions = {
  diagnostics: vscode.DiagnosticCollection;
  forcedMode?: ExplainMode;
  mode?: ExtractMode;
};

async function analyzeSelectionFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  options: AnalyzeSelectionOptions
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
      "SQLCortex: Select a connection before analyzing queries."
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("SQLCortex: Open a file to analyze SQL.");
    return;
  }

  const selectionText = editor.selection.isEmpty
    ? ""
    : editor.document.getText(editor.selection);
  if (!selectionText.trim()) {
    vscode.window.showWarningMessage("SQLCortex: Select SQL to analyze.");
    return;
  }

  const config = vscode.workspace.getConfiguration("sqlcortex");
  const maxSqlLength = resolveMaxSqlLength(config);
  if (selectionText.trim().length > maxSqlLength) {
    vscode.window.showErrorMessage(
      `SQLCortex: Selection is too large (max ${maxSqlLength} characters).`
    );
    return;
  }

  const extracted = extractSql(editor, options.mode ?? "selection");
  if (!extracted.sql) {
    vscode.window.showWarningMessage("SQLCortex: Select SQL to analyze.");
    return;
  }

  const validation = validateReadOnlySql(extracted.sql);
  if (!validation.ok) {
    vscode.window.showErrorMessage(`SQLCortex: ${validation.reason}`);
    return;
  }

  const explainMode =
    options.forcedMode ?? resolveExplainModeSetting(config);
  const allowed = await confirmExplainAnalyze(config, explainMode);
  if (!allowed) {
    return;
  }

  updateSqlDiagnostics({
    collection: options.diagnostics,
    document: editor.document,
    selection: editor.selection,
    sql: selectionText,
    enabled: resolveDiagnosticsEnabled(config),
  });

  const normalizedSql = normalizeSqlForHash(extracted.sql);
  if (!normalizedSql) {
    vscode.window.showWarningMessage("SQLCortex: SQL selection is empty.");
    return;
  }

  const sqlHash = hashSql(normalizedSql);
  const request: AnalyzeRequest = {
    orgId: resolveOrgId(workspaceContext, auth.session),
    projectId: workspaceContext.projectId,
    source: "vscode" as const,
    explainMode,
    allowAnalyze: resolveAllowAnalyze(config),
    sql: extracted.sql,
    sqlHash,
    connectionRef: workspaceContext.connectionId,
    clientContext: {
      extensionVersion: getExtensionVersion(context),
      workspaceIdHash: resolveWorkspaceIdHash(),
    },
  };

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );

  const insightsView = QueryInsightsView.show(context);
  try {
    const billingPlan = await getBillingPlan(client, workspaceContext.orgId ?? null);
    if (billingPlan.creditSystemEnabled) {
      const estimate = estimateCredits({
        action: "schema-analysis",
        sql: extracted.sql,
        modelTier: CREDIT_MODEL_TIER,
      });
      const remainingCredits = resolveRemainingCredits(billingPlan, estimate.total);
      const notice = buildCreditNotice(billingPlan);
      const confirmed = await insightsView.requestConfirmation({
        hash: sqlHash,
        mode: explainMode,
        estimatedCredits: estimate.total,
        remainingCredits,
        dailyCredits: billingPlan.dailyCredits ?? 0,
        notice,
      });
      if (!confirmed) {
        insightsView.update({ kind: "idle" });
        output.appendLine("SQLCortex: Analysis canceled before running.");
        return;
      }
    }
  } catch (err) {
    output.appendLine(`SQLCortex: Unable to load billing details: ${formatRequestError(err)}`);
  }

  insightsView.update({
    kind: "loading",
    data: { hash: sqlHash, mode: explainMode },
  });
  insightsView.setChatContext(null);

  output.show(true);
  output.appendLine(
    `SQLCortex: Analyzing selection ${sqlHash.slice(0, 8)} (${explainMode}).`
  );

  try {
    const response = await analyzeQuery(client, request);
    const findings = normalizeRuleFindings(response.findings).map(formatRuleFinding);
    const ai = response.ai;
    const aiSuggestions = normalizeAiSuggestions(ai?.suggestions);
    const suggestions = aiSuggestions.length
      ? aiSuggestions.map(formatAiSuggestion)
      : normalizeStringList((response as { suggestions?: unknown }).suggestions);
    const explanation =
      ai && typeof ai.explanation === "string" && ai.explanation.trim()
        ? ai.explanation.trim()
        : null;
    const warnings = [
      ...normalizeStringList(response.warnings),
      ...normalizeStringList(ai?.warnings),
    ];
    const assumptions = normalizeStringList(ai?.assumptions);
    const gateTitle = AI_LIMIT_MESSAGE;
    const gateDescription = AI_LIMIT_MESSAGE;
    const gate =
      response.status === "gated"
        ? {
            title: gateTitle,
            description: gateDescription,
            ctaLabel: "Upgrade to Pro",
            upgradeUrl: response.upgradeUrl ?? null,
          }
        : null;
    const insightsState = gate
      ? {
          kind: "gated" as const,
          data: {
            hash: sqlHash,
            mode: explainMode,
            findings,
            explanation,
            suggestions,
            warnings,
            assumptions,
            eventId: response.metering?.eventId ?? null,
            gate,
          },
        }
      : {
          kind: "success" as const,
          data: {
            hash: sqlHash,
            mode: explainMode,
            findings,
            explanation,
            suggestions,
            warnings,
            assumptions,
            eventId: response.metering?.eventId ?? null,
          },
        };
    insightsView.update(insightsState);
    const explainJson = response.explainJson ?? null;
    if (explainJson && workspaceContext.connectionId) {
      insightsView.setChatContext({
        sql: extracted.sql,
        explainJson,
        projectId: workspaceContext.projectId,
        connectionId: workspaceContext.connectionId,
      });
    } else {
      insightsView.setChatContext(null);
    }

    if (response.metering?.eventId) {
      output.appendLine(`SQLCortex: Analysis event ${response.metering.eventId}.`);
    }
    if (gate) {
      vscode.window.showWarningMessage(AI_LIMIT_MESSAGE);
    } else {
      vscode.window.showInformationMessage("SQLCortex: Analysis complete.");
    }
  } catch (err) {
    const message = formatRequestError(err);
    insightsView.update({
      kind: "error",
      error: { message },
      data: { hash: sqlHash, mode: explainMode },
    });
    insightsView.setChatContext(null);
    reportRequestError(output, "Analysis failed", err);
  }
}

async function handleQueryInsightsChat(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  input: { text: string; context: InsightsChatContext; history: InsightsChatMessage[] }
): Promise<{ answer: string }> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    throw new Error("Authentication required.");
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );

  const messages = input.history.map((message) => ({
    role: message.role,
    content: message.text,
  }));

  const response = await askQueryInsightsChat(client, {
    projectId: input.context.projectId,
    connectionId: input.context.connectionId,
    sql: input.context.sql,
    explainJson: input.context.explainJson,
    messages,
    source: "vscode",
  });

  if (response.status === "gated") {
    const fallback = response.answer?.trim() || AI_LIMIT_MESSAGE;
    return { answer: fallback };
  }

  const answer = response.answer?.trim() || "AI response is unavailable.";
  return { answer };
}

async function handleAgentChat(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  input: { text: string; context: AgentChatContext; history: AgentChatMessage[] }
): Promise<{ answer: string }> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    throw new Error("Authentication required.");
  }

  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );

  if (input.context.type === "query") {
    const messages = input.history.map((message) => ({
      role: message.role,
      content: message.text,
    }));
    const response = await askQueryInsightsChat(client, {
      projectId: input.context.projectId,
      connectionId: input.context.connectionId,
      sql: input.context.sql,
      explainJson: input.context.explainJson,
      messages,
      source: "vscode",
    });
    if (response.status === "gated") {
      const fallback = response.answer?.trim() || AI_LIMIT_MESSAGE;
      return { answer: fallback };
    }
    const answer = response.answer?.trim() || "AI response is unavailable.";
    return { answer };
  }

  const focus = input.context.tableName
    ? `Focus on table ${input.context.schemaName}.${input.context.tableName}.`
    : `Focus on schema ${input.context.schemaName}.`;
  const historySnippet = input.history
    .slice(-6)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n");
  const userIntentParts = [
    focus,
    input.context.tableContext ? `Table context:\n${input.context.tableContext}` : null,
    `User question: ${input.text}`,
    historySnippet ? `Conversation:\n${historySnippet}` : null,
  ].filter((item): item is string => Boolean(item));
  const userIntent = userIntentParts.join("\n");

  const response = await getSchemaInsights(client, {
    projectId: input.context.projectId,
    schemaName: input.context.schemaName,
    stats: input.context.stats,
    findings: input.context.findings,
    suggestions: input.context.suggestions,
    source: "vscode",
    userIntent,
  });

  if (response.status === "gated") {
    const fallback = response.ai?.explanation?.trim() || AI_LIMIT_MESSAGE;
    return { answer: fallback };
  }

  const ai = response.ai;
  const parts: string[] = [];
  if (ai?.explanation?.trim()) {
    parts.push(ai.explanation.trim());
  }
  const aiSuggestionList = normalizeAiSuggestions(ai?.suggestions);
  if (aiSuggestionList.length > 0) {
    parts.push(`Suggestions:\n${aiSuggestionList.map(formatAiSuggestion).join("\n")}`);
  }
  const warnings = [
    ...normalizeStringList(response.warnings),
    ...normalizeStringList(ai?.warnings),
  ];
  if (warnings.length > 0) {
    parts.push(`Warnings:\n${warnings.join("\n")}`);
  }
  const assumptions = [
    ...normalizeStringList(response.assumptions),
    ...normalizeStringList(ai?.assumptions),
  ];
  if (assumptions.length > 0) {
    parts.push(`Assumptions:\n${assumptions.join("\n")}`);
  }

  const answer = parts.join("\n\n") || "AI response is unavailable.";
  return { answer };
}

async function analyzeSchemaFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  dbExplorerProvider: DbExplorerProvider,
  node?: unknown
): Promise<void> {
  const actionContext = await resolveSchemaActionContext(
    context,
    tokenStore,
    output,
    statusBars,
    sidebarProvider,
    dbExplorerProvider,
    node
  );
  if (!actionContext) {
    return;
  }

  const { auth, projectId, connectionId, schemaName, tableName } = actionContext;
  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );

  const insightsView = QueryInsightsView.show(context);
  insightsView.update({
    kind: "loading",
    data: { hash: schemaName, mode: "SCHEMA" },
  });
  insightsView.setChatContext(null);
  const agentView = AgentViewProvider.show(context);
  const targetName = tableName ? `${schemaName}.${tableName}` : schemaName;
  const agentMode: "TABLE" | "SCHEMA" = tableName ? "TABLE" : "SCHEMA";
  const agentLabel = tableName ? `Table ${targetName}` : `Schema ${schemaName}`;
  agentView.updateInsights(
    {
      kind: "loading",
      data: { hash: targetName, mode: agentMode },
    },
    { contextLabel: agentLabel }
  );
  agentView.setChatContext(null, {
    contextLabel: agentLabel,
    disabledReason: "Analyzing insights...",
  });

  try {
    const metadata = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Loading schema ${schemaName}...`,
      },
      () =>
        getSchemaMetadata(
          client,
          projectId,
          connectionId,
          schemaName
        )
    );
    const analysis = tableName
      ? analyzeTableMetadata(metadata, tableName)
      : analyzeSchemaMetadata(metadata);
    let tableContext: string | null = null;
    if (tableName) {
      let constraints: TableConstraintInfo[] | null = null;
      try {
        constraints = await dbExplorerProvider.getTableConstraints(schemaName, tableName);
      } catch (err) {
        output.appendLine(
          `SQLCortex: Unable to load table constraints: ${formatRequestError(err)}`
        );
      }
      tableContext = buildTableContextSummary(metadata, tableName, constraints);
    }
    let aiSuggestions: string[] | null = null;
    let aiExplanation: string | null = null;
    let aiWarnings: string[] = [];
    let aiAssumptions: string[] = [];
    let gate:
      | {
          title: string;
          description: string;
          ctaLabel: string;
          upgradeUrl: string | null;
        }
      | null = null;
    let eventId: string | null = null;

    try {
      const focusIntent = tableName
        ? `Schema improvement recommendations focused on ${schemaName}.${tableName}.`
        : "Schema improvement recommendations.";
      const userIntent = tableContext
        ? `${focusIntent}\n\nTable context:\n${tableContext}`
        : focusIntent;
      const aiResponse = await getSchemaInsights(client, {
        projectId,
        schemaName,
        stats: analysis.stats,
        findings: analysis.findings,
        suggestions: analysis.suggestions,
        source: "vscode",
        userIntent,
      });
      const ai = aiResponse.ai;
      const aiSuggestionList = normalizeAiSuggestions(ai?.suggestions);
      if (aiSuggestionList.length > 0) {
        aiSuggestions = aiSuggestionList.map(formatAiSuggestion);
      }
      aiExplanation = ai?.explanation?.trim() ? ai.explanation.trim() : null;
      aiWarnings = normalizeStringList(ai?.warnings);
      aiAssumptions = normalizeStringList(ai?.assumptions);
      eventId = aiResponse.metering?.eventId ?? null;
      if (aiResponse.status === "gated") {
        gate = {
          title: AI_LIMIT_MESSAGE,
          description: AI_LIMIT_MESSAGE,
          ctaLabel: "Upgrade to Pro",
          upgradeUrl: aiResponse.upgradeUrl ?? null,
        };
      }
    } catch (err) {
      output.appendLine(
        `SQLCortex: Unable to load AI schema insights: ${formatRequestError(err)}`
      );
    }

    const hasAiContent = Boolean(
      aiExplanation ||
        (aiSuggestions && aiSuggestions.length > 0) ||
        aiWarnings.length > 0 ||
        aiAssumptions.length > 0
    );
    const suggestions = hasAiContent ? aiSuggestions ?? [] : analysis.suggestions;
    const explanation = hasAiContent ? aiExplanation : analysis.explanation;
    const warnings = hasAiContent ? aiWarnings : [...analysis.warnings, ...aiWarnings];
    const assumptions = hasAiContent ? aiAssumptions : [...analysis.assumptions, ...aiAssumptions];
    const findings = hasAiContent ? [] : analysis.findings;
    const schemaMode: "SCHEMA" = "SCHEMA";
    const payload = {
      hash: schemaName,
      mode: schemaMode,
      findings,
      suggestions,
      warnings,
      assumptions,
      explanation,
      eventId,
    };
    const agentPayload = {
      hash: targetName,
      mode: agentMode,
      findings,
      suggestions,
      warnings,
      assumptions,
      explanation,
      eventId,
    };

    insightsView.update(
      gate
        ? {
            kind: "gated",
            data: {
              ...payload,
              gate,
            },
          }
        : {
            kind: "success",
            data: payload,
          }
    );
    agentView.updateInsights(
      gate
        ? {
            kind: "gated",
            data: {
              ...agentPayload,
              gate,
            },
          }
        : {
            kind: "success",
            data: agentPayload,
          },
      { contextLabel: agentLabel }
    );
    if (gate) {
      agentView.setChatContext(null, {
        contextLabel: agentLabel,
        disabledReason: gate.title,
      });
    } else {
      agentView.setChatContext(
        {
          type: "schema",
          projectId,
          schemaName,
          tableName,
          stats: analysis.stats,
          findings: analysis.findings,
          suggestions: analysis.suggestions,
          tableContext,
        },
        { contextLabel: agentLabel }
      );
    }
    vscode.window.showInformationMessage(
      `SQLCortex: Schema analysis complete for ${schemaName}.`
    );
  } catch (err) {
    const message = formatRequestError(err);
    insightsView.update({
      kind: "error",
      error: { message },
      data: { hash: schemaName, mode: "SCHEMA" },
    });
    agentView.updateInsights(
      {
        kind: "error",
        error: { message },
        data: { hash: targetName, mode: agentMode },
      },
      { contextLabel: agentLabel }
    );
    agentView.setChatContext(null, {
      contextLabel: agentLabel,
      disabledReason: message,
    });
    reportRequestError(output, "Schema analysis failed", err);
  }
}

function buildTableContextSummary(
  metadata: SchemaMetadataResponse,
  tableName: string,
  constraints: TableConstraintInfo[] | null
): string | null {
  const table = metadata.tables.find((item) => item.name === tableName) ?? null;
  if (!table) {
    return null;
  }

  const incoming = collectIncomingForeignKeys(metadata.tables, table);
  const lines: string[] = [];
  lines.push(`Table: ${metadata.schema}.${table.name}`);

  lines.push(`Columns (${table.columns.length}):`);
  lines.push(
    ...formatList(
      table.columns.map(formatColumnSummary),
      "None"
    )
  );

  lines.push(`Indexes (${table.indexes.length}):`);
  lines.push(
    ...formatList(
      table.indexes.map(formatIndexSummary),
      "None"
    )
  );

  const constraintItems =
    constraints === null
      ? ["Unavailable"]
      : constraints.length === 0
        ? ["None"]
        : constraints.map((constraint) => formatConstraintSummary(constraint));
  lines.push(`Constraints (${constraints ? constraints.length : 0}):`);
  lines.push(...formatList(constraintItems, "None"));

  lines.push(`Relationships (outgoing) (${table.foreignKeys.length}):`);
  lines.push(
    ...formatList(
      table.foreignKeys.map((fk) => formatForeignKeySummary(fk, table)),
      "None"
    )
  );

  lines.push(`Relationships (incoming) (${incoming.length}):`);
  lines.push(
    ...formatList(
      incoming.map((entry) => formatForeignKeySummary(entry.fk, entry.table)),
      "None"
    )
  );

  return lines.join("\n");
}

function formatList(items: string[], emptyLabel: string): string[] {
  if (items.length === 0) {
    return [`- ${emptyLabel}`];
  }
  return items.map((item) => `- ${item}`);
}

function formatColumnSummary(column: SchemaColumnResource): string {
  const parts: string[] = [];
  parts.push(column.name);
  parts.push(column.type);
  parts.push(column.nullable ? "NULL" : "NOT NULL");
  if (column.default) {
    parts.push(`default ${column.default}`);
  }
  return parts.join(" ");
}

function formatIndexSummary(index: IndexInfo): string {
  const parts: string[] = [];
  if (index.primary) {
    parts.push("primary");
  } else if (index.unique) {
    parts.push("unique");
  } else {
    parts.push("index");
  }
  if (index.method) {
    parts.push(index.method);
  }
  const columns = index.columns.length > 0 ? `(${index.columns.join(", ")})` : "";
  if (columns) {
    parts.push(columns);
  }
  if (index.predicate) {
    parts.push(`WHERE ${index.predicate}`);
  }
  return `${index.name}: ${parts.join(" ")}`.trim();
}

function formatConstraintSummary(constraint: TableConstraintInfo): string {
  const summary = constraint.summary?.trim();
  if (summary) {
    return `${constraint.name}: ${sanitizeConstraintSummary(summary)}`;
  }
  return `${constraint.name}: ${constraint.type}`;
}

function sanitizeConstraintSummary(value: string): string {
  return value.replace(/\u2192|â†’/g, "->");
}

function formatForeignKeySummary(fk: ForeignKeyInfo, source: TableInfo): string {
  const localColumns = fk.columns.length > 0 ? `(${fk.columns.join(", ")})` : "";
  const foreignColumns =
    fk.foreignColumns.length > 0 ? `(${fk.foreignColumns.join(", ")})` : "";
  const foreignTable = `${fk.foreignSchema}.${fk.foreignTable}${foreignColumns}`;
  const direction = localColumns
    ? `${source.name}${localColumns} -> ${foreignTable}`
    : `${source.name} -> ${foreignTable}`;
  const onDelete = fk.onDelete?.trim() || "NO ACTION";
  const onUpdate = fk.onUpdate?.trim() || "NO ACTION";
  return `${direction} | ON DELETE ${onDelete}, ON UPDATE ${onUpdate}`;
}

function collectIncomingForeignKeys(
  tables: TableInfo[],
  target: TableInfo
): Array<{ table: TableInfo; fk: ForeignKeyInfo }> {
  const matches: Array<{ table: TableInfo; fk: ForeignKeyInfo }> = [];
  for (const table of tables) {
    if (table.name === target.name && table.schema === target.schema) {
      continue;
    }
    for (const fk of table.foreignKeys) {
      if (fk.foreignTable === target.name && fk.foreignSchema === target.schema) {
        matches.push({ table, fk });
      }
    }
  }
  return matches;
}

async function drawSchemaErdFlow(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  dbExplorerProvider: DbExplorerProvider,
  node?: unknown
): Promise<void> {
  const actionContext = await resolveSchemaActionContext(
    context,
    tokenStore,
    output,
    statusBars,
    sidebarProvider,
    dbExplorerProvider,
    node
  );
  if (!actionContext) {
    return;
  }

  const { auth, projectId, connectionId, schemaName } = actionContext;
  const client = createAuthorizedClient(
    context,
    auth,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );

  try {
    const metadata = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Generating ERD for ${schemaName}...`,
      },
      () =>
        getSchemaMetadata(
          client,
          projectId,
          connectionId,
          schemaName
        )
    );
    const analysis = analyzeSchemaMetadata(metadata);
    let improvements: string[] | null = null;
    try {
      const aiResponse = await getSchemaInsights(client, {
        projectId,
        schemaName,
        stats: analysis.stats,
        findings: analysis.findings,
        suggestions: analysis.suggestions,
        source: "vscode",
        userIntent: "Schema ERD improvement recommendations.",
      });
      const aiSuggestionList = normalizeAiSuggestions(aiResponse.ai?.suggestions);
      if (aiSuggestionList.length > 0) {
        improvements = aiSuggestionList.map(formatAiSuggestion);
      }
      if (aiResponse.status === "gated") {
        vscode.window.showWarningMessage(AI_LIMIT_MESSAGE);
      }
    } catch (err) {
      output.appendLine(
        `SQLCortex: Unable to load AI schema insights: ${formatRequestError(err)}`
      );
    }
    const nonce = createNonce();
    const html = buildSchemaErdHtml(metadata, analysis, nonce, {
      improvements: improvements ?? undefined,
    });
    const title = `Schema ERD: ${schemaName}`;
    if (!schemaErdPanel) {
      schemaErdPanel = vscode.window.createWebviewPanel(
        "sqlcortex.schemaErd",
        title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true }
      );
      schemaErdPanel.onDidDispose(() => {
        schemaErdPanel = undefined;
      });
    } else {
      schemaErdPanel.title = title;
      schemaErdPanel.reveal(vscode.ViewColumn.Active, true);
    }
    schemaErdPanel.webview.html = html;
    vscode.window.showInformationMessage(`SQLCortex: ERD generated for ${schemaName}.`);
  } catch (err) {
    reportRequestError(output, "ERD generation failed", err);
  }
}

async function resolveSchemaActionContext(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  dbExplorerProvider: DbExplorerProvider,
  node?: unknown
): Promise<{
  auth: { baseUrl: string; token: string; session: SessionSnapshot };
  projectId: string;
  connectionId: string;
  schemaName: string;
  tableName?: string | null;
} | null> {
  const auth = await resolveAuthContext(context, tokenStore, output);
  if (!auth) {
    return null;
  }

  const workspaceContext = await ensureActiveProject(
    context,
    tokenStore,
    output,
    statusBars,
    sidebarProvider
  );
  if (!workspaceContext || !workspaceContext.projectId) {
    return null;
  }
  if (!workspaceContext.connectionId) {
    vscode.window.showErrorMessage(
      "SQLCortex: Select a connection before analyzing schemas."
    );
    return null;
  }

  const projectId = workspaceContext.projectId;
  const connectionId = workspaceContext.connectionId;
  let tableName: string | null = null;
  if (node instanceof TableNode) {
    tableName = node.table.name;
  } else if (node instanceof ColumnNode) {
    tableName = node.tableName;
  }
  const schemaName = await resolveSchemaNameFromNode(dbExplorerProvider, node);
  if (!schemaName) {
    return null;
  }

  return { auth, projectId, connectionId, schemaName, tableName };
}

async function resolveSchemaNameFromNode(
  dbExplorerProvider: DbExplorerProvider,
  node?: unknown
): Promise<string | null> {
  if (node instanceof SchemaNode) {
    return node.schemaName;
  }
  if (node instanceof TableNode) {
    return node.schemaName;
  }
  if (node instanceof ColumnNode) {
    return node.schemaName;
  }

  const schemas = await dbExplorerProvider.getSchemasForSearch();
  if (!schemas) {
    return null;
  }
  if (schemas.length === 0) {
    vscode.window.showInformationMessage("SQLCortex: No schemas available.");
    return null;
  }

  const schemaItems: SchemaPickItem[] = schemas.map((schema) => ({
    label: schema.name,
    schemaName: schema.name,
  }));

  const schemaSelection = await vscode.window.showQuickPick(schemaItems, {
    placeHolder: "Select a schema",
    ignoreFocusOut: true,
  });

  return schemaSelection?.schemaName ?? null;
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
    if (isSchemaMutatingSql(extracted.sql)) {
      dbCopilotSchemaRefreshScheduler?.schedule();
      output.appendLine("SQLCortex: Scheduled schema refresh after DDL execution.");
    }
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

function isSchemaMutatingSql(sql: string): boolean {
  const withoutLineComments = sql.replace(/--.*$/gm, " ");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, " ");
  const keyword = withoutBlockComments.trim().match(/\b([a-zA-Z]+)\b/)?.[1]?.toLowerCase();
  return (
    keyword === "create" ||
    keyword === "alter" ||
    keyword === "drop" ||
    keyword === "truncate" ||
    keyword === "rename" ||
    keyword === "comment"
  );
}

function buildTableSelectSql(schemaName: string, tableName: string): string {
  return `SELECT * FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

type DbCopilotRefreshable = {
  refresh: () => void;
};

type DbCopilotPanelSpec = {
  title: string;
  description: string;
  bullets?: string[];
};

const dbCopilotPanels = new Map<string, vscode.WebviewPanel>();

function resolveApiBaseUrlFromState(context: vscode.ExtensionContext): string | null {
  const stored = context.globalState.get<string>(API_BASE_URL_KEY);
  if (stored && stored.trim()) {
    return stored.trim();
  }
  return DEFAULT_API_BASE_URL;
}

function buildDbCopilotTargetLabel(target: SelectedTarget): string {
  return `${target.orgName} / ${target.projectName} / ${target.envName}`;
}

async function syncDbCopilotTargetStatusBar(
  sessionManager: ApiSessionManager,
  targetStore: TargetStore,
  item: vscode.StatusBarItem
): Promise<void> {
  const token = await sessionManager.getToken();
  const target = targetStore.getSelectedTarget();
  updateTargetStatusBar(item, {
    loggedIn: Boolean(token),
    target,
  });
}

async function applySelectedTarget(
  context: vscode.ExtensionContext,
  target: SelectedTarget,
  tokenStore: ReturnType<typeof createTokenStore>,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  dbExplorerProvider: DbExplorerProvider,
  dbCopilotStatusBars: DbCopilotStatusBarItems,
  dbCopilotProviders: DbCopilotRefreshable[]
): Promise<void> {
  await setActiveOrg(context, target.orgId, target.orgName);
  await setActiveProject(context, target.projectId, target.projectName);
  await setActiveConnection(context, target.envId, target.envName);
  await setDbCopilotConnection(
    context,
    buildDbCopilotTargetLabel(target),
    buildDbCopilotTargetLabel(target),
    true
  );
  await setDbCopilotSchemaSnapshot(context, false);
  await setDbCopilotSchemaSnapshots(context, null);
  resetDbCopilotBottomPanel();
  dbExplorerProvider.clearCache();
  dbExplorerProvider.refresh();
  await refreshContext(context, tokenStore, statusBars, sidebarProvider);
  await refreshDbCopilotUI(context, dbCopilotStatusBars, dbCopilotProviders);
}

async function restoreDbCopilotTargetIfAvailable(
  context: vscode.ExtensionContext,
  sessionManager: ApiSessionManager,
  targetStore: TargetStore,
  tokenStore: ReturnType<typeof createTokenStore>,
  statusBars: StatusBarItems,
  sidebarProvider: SidebarProvider | undefined,
  dbExplorerProvider: DbExplorerProvider,
  dbCopilotStatusBars: DbCopilotStatusBarItems,
  dbCopilotProviders: DbCopilotRefreshable[],
  targetStatusBar: vscode.StatusBarItem
): Promise<void> {
  const token = await sessionManager.getToken();
  if (!token) {
    return;
  }
  const target = targetStore.getSelectedTarget();
  if (!target) {
    return;
  }
  await applySelectedTarget(
    context,
    target,
    tokenStore,
    statusBars,
    sidebarProvider,
    dbExplorerProvider,
    dbCopilotStatusBars,
    dbCopilotProviders
  );
  await syncDbCopilotTargetStatusBar(sessionManager, targetStore, targetStatusBar);
}

async function refreshDbCopilotUI(
  context: vscode.ExtensionContext,
  statusBars: DbCopilotStatusBarItems,
  providers: DbCopilotRefreshable[]
): Promise<void> {
  const state = getDbCopilotState(context);
  updateDbCopilotStatusBar(statusBars, {
    ...state,
    policiesCount: DBCOPILOT_POLICY_NOTES.length,
  });
  for (const provider of providers) {
    provider.refresh();
  }
  await vscode.commands.executeCommand(
    "setContext",
    "dbcopilot.connected",
    Boolean(state.connectionLabel)
  );
  await vscode.commands.executeCommand(
    "setContext",
    "dbcopilot.schemaSnapshot",
    state.schemaSnapshotAvailable
  );
  await vscode.commands.executeCommand("setContext", "dbcopilot.mode", state.mode);
}

async function syncDbCopilotConnectionState(
  context: vscode.ExtensionContext,
  state: ConnectionState,
  statusBars: DbCopilotStatusBarItems,
  providers: DbCopilotRefreshable[]
): Promise<void> {
  if (state.status === "connected" && state.profile) {
    const labels = buildDbCopilotConnectionLabels(state.profile);
    await setDbCopilotConnection(
      context,
      labels.connectionLabel,
      labels.displayLabel,
      state.profile.readOnly
    );
  } else {
    await setDbCopilotConnection(context, null, null, null);
  }
  await setDbCopilotSchemaSnapshot(context, false);
  await setDbCopilotSchemaSnapshots(context, null);
  resetDbCopilotBottomPanel();
  await refreshDbCopilotUI(context, statusBars, providers);
}

function buildDbCopilotConnectionLabels(profile: ConnectionProfile): {
  connectionLabel: string;
  displayLabel: string;
} {
  const displayLabel = `${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
  const connectionLabel = `postgres:${profile.name}@${profile.host}:${profile.port}/${profile.database}`;
  return { connectionLabel, displayLabel };
}

function resetDbCopilotBottomPanel(): void {
  dbCopilotSqlPreviewState = null;
  dbCopilotRiskImpactState = null;
  dbCopilotOptimizationPlan = null;
  dbCopilotLogEntries = [];
  dbCopilotLogStreamId += 1;
  dbCopilotSqlPreviewView?.update(null);
  dbCopilotRiskImpactView?.update(null);
  dbCopilotLogsView?.setEntries([]);
}

function resolveDbCopilotExecutionPolicy(
  context: vscode.ExtensionContext
): {
  allowsExecution: boolean;
  reason: string | null;
} {
  const state = getDbCopilotState(context);
  const dbEngine = resolveDbCopilotDbEngine(state.connectionLabel ?? null);
  const policies = resolveDbCopilotPolicies(state.connectionLabel ?? null, dbEngine);
  if (policies.env === "prod") {
    return {
      allowsExecution: false,
      reason: "Execution blocked in production (enterprise override required).",
    };
  }
  if (!dbCopilotRiskImpactState) {
    return {
      allowsExecution: false,
      reason: "Awaiting risk and governance review.",
    };
  }
  if (dbCopilotRiskImpactState?.requiresManualReview) {
    return {
      allowsExecution: false,
      reason:
        dbCopilotRiskImpactState.requiresManualReviewReason ||
        "Manual review required.",
    };
  }
  return { allowsExecution: true, reason: null };
}

function setDbCopilotRiskImpactState(
  context: vscode.ExtensionContext,
  state: DbCopilotRiskImpactState | null
): void {
  dbCopilotRiskImpactState = state;
  dbCopilotRiskImpactView?.update(state);
  if (dbCopilotSqlPreviewState) {
    syncDbCopilotSqlPreviewMode(context);
  }
}

function setDbCopilotSqlPreviewState(
  context: vscode.ExtensionContext,
  state: DbCopilotSqlPreviewState | null
): void {
  if (!state) {
    dbCopilotSqlPreviewState = null;
    dbCopilotSqlPreviewView?.update(null);
    return;
  }
  const policy = resolveDbCopilotExecutionPolicy(context);
  dbCopilotSqlPreviewState = {
    ...state,
    mode: getDbCopilotState(context).mode,
    policyAllowsExecution: policy.allowsExecution,
    policyReason: policy.reason,
  };
  dbCopilotSqlPreviewView?.update(dbCopilotSqlPreviewState);
}

function syncDbCopilotSqlPreviewMode(context: vscode.ExtensionContext): void {
  if (!dbCopilotSqlPreviewState) {
    return;
  }
  const policy = resolveDbCopilotExecutionPolicy(context);
  dbCopilotSqlPreviewState = {
    ...dbCopilotSqlPreviewState,
    mode: getDbCopilotState(context).mode,
    policyAllowsExecution: policy.allowsExecution,
    policyReason: policy.reason,
  };
  dbCopilotSqlPreviewView?.update(dbCopilotSqlPreviewState);
}

function appendDbCopilotLogEntry(entry: DbCopilotLogEntry): void {
  dbCopilotLogEntries = [...dbCopilotLogEntries, entry];
  dbCopilotLogsView?.appendEntries([entry]);
}

function streamDbCopilotLogs(entries: DbCopilotLogEntry[]): void {
  dbCopilotLogStreamId += 1;
  const streamId = dbCopilotLogStreamId;
  dbCopilotLogEntries = [];
  dbCopilotLogsView?.setEntries([]);
  entries.forEach((entry, index) => {
    const delay = 200 * index;
    setTimeout(() => {
      if (dbCopilotLogStreamId !== streamId) {
        return;
      }
      appendDbCopilotLogEntry(entry);
    }, delay);
  });
}

function setDbCopilotAuditLogs(plan: DbCopilotOptimizationPlan): void {
  dbCopilotAuditLogEntries = plan.auditLogs ?? [];
  dbCopilotAuditLogSessionId = plan.logSessionId ?? null;
  dbCopilotAgentLogsPanel?.setEntries(dbCopilotAuditLogEntries);
  void persistDbCopilotAuditLogs(
    dbCopilotAuditLogSessionId,
    dbCopilotAuditLogEntries
  );
}

async function persistDbCopilotAuditLogs(
  sessionId: string | null,
  entries: DbCopilotAuditLogEntry[]
): Promise<void> {
  if (!sessionId || !entries.length) {
    return;
  }
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
      return;
    }
    const date = resolveLogDate(entries[0]?.timestamp);
    const logRoot = vscode.Uri.joinPath(workspaceFolder, ".sqlcortex", "logs", date);
    await vscode.workspace.fs.createDirectory(logRoot);
    const logUri = vscode.Uri.joinPath(logRoot, `${sessionId}.jsonl`);
    const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeTextFile(logUri, content);
  } catch {
    // Ignore persistence errors to avoid blocking UI flows.
  }
}

function resolveLogDate(timestamp: string | undefined): string {
  if (timestamp) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function buildDbCopilotLogEntry(
  source: DbCopilotLogEntry["source"],
  message: string
): DbCopilotLogEntry {
  const timestamp = formatDbCopilotLogTimestamp(new Date());
  return {
    id: `${timestamp}-${source}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp,
    source,
    message,
  };
}

function formatDbCopilotLogTimestamp(value: Date): string {
  const hours = value.getHours().toString().padStart(2, "0");
  const minutes = value.getMinutes().toString().padStart(2, "0");
  const seconds = value.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function sanitizeMigrationId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function ensureTrailingNewline(value: string): string {
  if (!value) {
    return "";
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function writeTextFile(
  uri: vscode.Uri,
  content: string
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

function summarizeSql(statement: string): string {
  const trimmed = statement.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
  if (!trimmed) {
    return "SQL statement";
  }
  if (trimmed.length > 80) {
    return `${trimmed.slice(0, 77)}...`;
  }
  return trimmed;
}

function formatDbCopilotEnvironment(env: DbCopilotMigrationPlan["environment"]): string {
  switch (env) {
    case "prod":
      return "Production";
    case "staging":
      return "Staging";
    default:
      return "Development";
  }
}

async function syncDbCopilotSchemaSnapshot(
  context: vscode.ExtensionContext,
  sessionManager: ApiSessionManager,
  targetStore: TargetStore,
  statusBars: DbCopilotStatusBarItems,
  providers: DbCopilotRefreshable[],
  successMessage?: string
): Promise<void> {
  await setDbCopilotSchemaSnapshotStatus(context, "loading");
  await refreshDbCopilotUI(context, statusBars, providers);
  try {
    const target = targetStore.getSelectedTarget();
    if (!target) {
      throw new Error("Select a target before refreshing schema.");
    }

    const schemaApi = new SchemaApi(await sessionManager.getClientOrThrow());
    const targetRef = {
      projectId: target.projectId,
      envId: target.envId,
    };

    const refreshResponse = await schemaApi.refreshSnapshot(targetRef);
    const schemaSnapshot = refreshResponse.snapshot ?? (await schemaApi.getSnapshot(targetRef));
    const snapshots = mapSchemaSnapshotToDbCopilotSnapshots(schemaSnapshot);

    await setDbCopilotSchemaSnapshots(context, snapshots);
    await setDbCopilotSchemaSnapshotStatus(context, "ready");
    resetDbCopilotBottomPanel();
    await refreshDbCopilotUI(context, statusBars, providers);
    if (successMessage) {
      vscode.window.showInformationMessage(successMessage);
    }
  } catch (err) {
    const message = formatDbCopilotSchemaSyncError(err, sessionManager);
    await setDbCopilotSchemaSnapshots(context, null);
    await setDbCopilotSchemaSnapshotStatus(context, "error", message);
    resetDbCopilotBottomPanel();
    await refreshDbCopilotUI(context, statusBars, providers);
    vscode.window.showErrorMessage(`DB Copilot: ${message}`);
  }
}

function mapSchemaSnapshotToDbCopilotSnapshots(
  snapshot: SchemaSnapshot
): DbCopilotSchemaSnapshots {
  const snapshots: DbCopilotSchemaSnapshots = {};

  for (const schema of snapshot.schemas) {
    const schemaName = schema.name.trim();
    if (!schemaName) {
      continue;
    }

    snapshots[schemaName] = {
      schema: schemaName,
      tables: schema.tables.map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.dataType,
          nullable: column.nullable,
          default: column.default,
        })),
        primaryKey: resolvePrimaryKeyColumns(table),
        constraints: table.constraints.map((constraint) => ({
          name: constraint.name,
          type: constraint.type,
          columns: [...constraint.columns],
          definition: constraint.definition,
        })),
        foreignKeys: table.foreignKeys.map((foreignKey) => ({
          name: foreignKey.name,
          columns: [...foreignKey.columns],
          references: {
            schema: foreignKey.referencedSchema,
            table: foreignKey.referencedTable,
            columns: [...foreignKey.referencedColumns],
          },
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        })),
        indexes: table.indexes.map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          method: index.method ?? "unknown",
          primary: index.primary,
        })),
      })),
      views: schema.views.map((view) => ({
        name: view.name,
        definition: view.definition,
      })),
      routines: schema.routines.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
      functions: schema.functions.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
      procedures: schema.procedures.map((routine) => ({
        name: routine.name,
        kind: routine.kind,
        signature: routine.signature,
        returnType: routine.returnType,
        language: routine.language,
        definition: routine.definition,
      })),
      capturedAt: snapshot.capturedAt ?? null,
    };
  }

  return snapshots;
}

function resolvePrimaryKeyColumns(table: SchemaSnapshot["schemas"][number]["tables"][number]): string[] {
  const primaryConstraint = table.constraints.find(
    (constraint) => constraint.type.trim().toUpperCase() === "PRIMARY KEY"
  );
  if (primaryConstraint && primaryConstraint.columns.length > 0) {
    return [...primaryConstraint.columns];
  }

  const primaryIndex = table.indexes.find((index) => index.primary && index.columns.length > 0);
  if (primaryIndex) {
    return [...primaryIndex.columns];
  }

  return [];
}

function formatDbCopilotSchemaSyncError(
  err: unknown,
  sessionManager: ApiSessionManager
): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  const normalized = sessionManager.formatError(err).trim();
  return normalized.length > 0 ? normalized : "Schema snapshot refresh failed.";
}

async function ensureDbCopilotConnected(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const state = getDbCopilotState(context);
  if (state.connectionLabel) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    "DB Copilot: Select a target to continue.",
    "Select Target"
  );
  if (choice === "Select Target") {
    await vscode.commands.executeCommand("dbcopilot.selectTarget");
  }
  return false;
}

async function ensureDbCopilotSnapshot(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const state = getDbCopilotState(context);
  if (state.schemaSnapshotAvailable) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    "DB Copilot: Capture a schema snapshot to continue.",
    "Capture Schema Snapshot"
  );
  if (choice === "Capture Schema Snapshot") {
    await vscode.commands.executeCommand("dbcopilot.captureSchemaSnapshot");
  }
  return false;
}

function resolveDbCopilotActiveSqlText(): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const selection = editor.selection && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection)
    : editor.document.getText();
  const trimmed = selection.trim();
  return trimmed.length ? trimmed : null;
}

function resolveDbCopilotSchemaName(node: unknown): string | null {
  if (node instanceof DbCopilotSchemaNode) {
    return node.schemaName;
  }
  return null;
}

async function toggleDbCopilotMode(
  context: vscode.ExtensionContext,
  statusBars: DbCopilotStatusBarItems,
  providers: DbCopilotRefreshable[]
): Promise<void> {
  const state = getDbCopilotState(context);
  const nextMode = getNextDbCopilotMode(state.mode);
  if (nextMode === "execution") {
    const confirmation = await vscode.window.showWarningMessage(
      "DB Copilot: Execution mode can apply changes. Continue?",
      { modal: true },
      "Enter Execution"
    );
    if (confirmation !== "Enter Execution") {
      return;
    }
  }
  await setDbCopilotMode(context, nextMode);
  await refreshDbCopilotUI(context, statusBars, providers);
  syncDbCopilotSqlPreviewMode(context);
  vscode.window.showInformationMessage(
    `DB Copilot: Mode set to ${formatDbCopilotMode(nextMode)}.`
  );
}

function getNextDbCopilotMode(current: DbCopilotMode): DbCopilotMode {
  switch (current) {
    case "readOnly":
      return "draft";
    case "draft":
      return "execution";
    case "execution":
    default:
      return "readOnly";
  }
}

function formatDbCopilotMode(mode: DbCopilotMode): string {
  switch (mode) {
    case "readOnly":
      return "Read-Only";
    case "draft":
      return "Draft";
    case "execution":
      return "Execution";
  }
}

function resolveDbCopilotSnapshot(
  context: vscode.ExtensionContext,
  schemaName: string | null
): DbCopilotSchemaSnapshot | null {
  if (schemaName) {
    const direct = getDbCopilotSchemaSnapshot(context, schemaName);
    if (direct) {
      return direct;
    }
  }
  const snapshots = getDbCopilotSchemaSnapshots(context);
  if (!snapshots) {
    return null;
  }
  const first = Object.values(snapshots)[0];
  return first ?? null;
}

function openDbCopilotErdDiagram(
  context: vscode.ExtensionContext,
  snapshot: DbCopilotSchemaSnapshot
): void {
  const title = `ER Diagram: ${snapshot.schema}`;
  const mermaidRoot = vscode.Uri.joinPath(
    context.extensionUri,
    "node_modules",
    "mermaid",
    "dist"
  );

  if (!dbCopilotErdPanel) {
    dbCopilotErdPanel = vscode.window.createWebviewPanel(
      "dbcopilot.erdDiagram",
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mermaidRoot],
      }
    );
    dbCopilotErdPanel.onDidDispose(() => {
      dbCopilotErdPanel = undefined;
      dbCopilotErdSnapshot = null;
    });
    dbCopilotErdPanel.webview.onDidReceiveMessage(
      async (message: { type?: string; dataUrl?: string; text?: string }) => {
        if (!message || typeof message.type !== "string") {
          return;
        }
        switch (message.type) {
          case "copyMermaid":
            if (typeof message.text === "string") {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.showInformationMessage(
                "DB Copilot: Mermaid diagram copied to clipboard."
              );
            }
            break;
          case "exportPng":
            if (typeof message.dataUrl === "string") {
              await exportDbCopilotErdPng(message.dataUrl, dbCopilotErdSnapshot);
            }
            break;
          case "openRecommendations":
            await vscode.commands.executeCommand(
              "workbench.view.extension.dbcopilot"
            );
            await vscode.commands.executeCommand("dbcopilot.recommendations.focus");
            if (dbCopilotErdSnapshot) {
              vscode.window.showInformationMessage(
                `DB Copilot: Recommendations opened for ${dbCopilotErdSnapshot.schema}.`
              );
            }
            break;
          default:
            break;
        }
      }
    );
  }

  dbCopilotErdSnapshot = snapshot;
  const panel = dbCopilotErdPanel;
  if (!panel) {
    return;
  }
  panel.title = title;
  panel.reveal(vscode.ViewColumn.Active, true);

  const mermaidUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(mermaidRoot, "mermaid.min.js")
  );
  const html = buildDbCopilotErdHtml({
    webview: panel.webview,
    snapshot,
    mermaidUri,
    nonce: createNonce(),
  });
  panel.webview.html = html;
}

function openDbCopilotOptimizationPlan(
  context: vscode.ExtensionContext,
  plan: DbCopilotOptimizationPlan | null
): void {
  const panel = vscode.window.createWebviewPanel(
    "dbcopilot.optimizationPlan",
    "Optimization Plan",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: false,
      retainContextWhenHidden: true,
    }
  );
  panel.webview.html = buildDbCopilotOptimizationPlanHtml(plan);
}

function resolveDbCopilotMigrationPlan(
  context: vscode.ExtensionContext
): DbCopilotMigrationPlan | null {
  if (!dbCopilotOptimizationPlan) {
    return null;
  }
  const state = getDbCopilotState(context);
  const dbEngine = resolveDbCopilotDbEngine(state.connectionLabel ?? null);
  const policies = resolveDbCopilotPolicies(state.connectionLabel ?? null, dbEngine);
  return buildDbCopilotMigrationPlan({
    plan: dbCopilotOptimizationPlan,
    mode: state.mode,
    engine: dbEngine,
    policies,
  });
}

function openDbCopilotMigrationPlan(
  context: vscode.ExtensionContext,
  deps: {
    tokenStore: ReturnType<typeof createTokenStore>;
    output: vscode.OutputChannel;
    statusBars: StatusBarItems;
    sidebarProvider?: SidebarProvider;
  }
): void {
  const plan = resolveDbCopilotMigrationPlan(context);
  let panel = dbCopilotMigrationPlanPanel;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "dbcopilot.migrationPlan",
      "Migration Plan",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    panel.onDidDispose(() => {
      if (dbCopilotMigrationPlanPanel === panel) {
        dbCopilotMigrationPlanPanel = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(
      (message) => void handleDbCopilotMigrationPlanMessage(context, deps, message)
    );
    dbCopilotMigrationPlanPanel = panel;
  }

  panel.title = "Migration Plan";
  panel.webview.html = buildDbCopilotMigrationPlanHtml({
    webview: panel.webview,
    plan,
  });
  panel.reveal(vscode.ViewColumn.Active, true);
}

async function handleDbCopilotMigrationPlanMessage(
  context: vscode.ExtensionContext,
  deps: {
    tokenStore: ReturnType<typeof createTokenStore>;
    output: vscode.OutputChannel;
    statusBars: StatusBarItems;
    sidebarProvider?: SidebarProvider;
  },
  message: unknown
): Promise<void> {
  const payload = message as { type?: string } | undefined;
  if (!payload || typeof payload !== "object") {
    return;
  }

  switch (payload.type) {
    case "exportSql":
      await exportDbCopilotMigrationSql(context);
      return;
    case "exportYaml":
      await exportDbCopilotMigrationYaml(context);
      return;
    case "saveMigration":
      await saveDbCopilotMigrationArtifacts(context);
      return;
    case "executeMigration":
      await executeDbCopilotMigrationPlan(
        context,
        deps.tokenStore,
        deps.output,
        deps.statusBars,
        deps.sidebarProvider
      );
      return;
    default:
      return;
  }
}

async function exportDbCopilotMigrationSql(
  context: vscode.ExtensionContext
): Promise<void> {
  const plan = resolveDbCopilotMigrationPlan(context);
  if (!plan) {
    vscode.window.showWarningMessage("DB Copilot: No migration plan to export.");
    return;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder, `${sanitizeMigrationId(plan.id)}.sql`)
    : undefined;
  const destination = await vscode.window.showSaveDialog({
    filters: { SQL: ["sql"] },
    defaultUri,
    title: "Export migration SQL",
  });
  if (!destination) {
    return;
  }
  const content = buildDbCopilotMigrationSqlExport(plan);
  await writeTextFile(destination, content);
  vscode.window.showInformationMessage(
    `DB Copilot: Migration SQL exported to ${destination.fsPath}.`
  );
}

async function exportDbCopilotMigrationYaml(
  context: vscode.ExtensionContext
): Promise<void> {
  const plan = resolveDbCopilotMigrationPlan(context);
  if (!plan) {
    vscode.window.showWarningMessage("DB Copilot: No migration plan to export.");
    return;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder, `${sanitizeMigrationId(plan.id)}.yaml`)
    : undefined;
  const destination = await vscode.window.showSaveDialog({
    filters: { YAML: ["yaml", "yml"] },
    defaultUri,
    title: "Export migration YAML",
  });
  if (!destination) {
    return;
  }
  await writeTextFile(destination, plan.artifacts.migrationYaml);
  vscode.window.showInformationMessage(
    `DB Copilot: Migration YAML exported to ${destination.fsPath}.`
  );
}

async function saveDbCopilotMigrationArtifacts(
  context: vscode.ExtensionContext
): Promise<void> {
  const plan = resolveDbCopilotMigrationPlan(context);
  if (!plan) {
    vscode.window.showWarningMessage("DB Copilot: No migration plan to save.");
    return;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      "DB Copilot: Open a workspace to save migration artifacts."
    );
    return;
  }

  const migrationId = sanitizeMigrationId(plan.id);
  const migrationRoot = vscode.Uri.joinPath(
    workspaceFolder,
    ".sqlcortex",
    "migrations",
    migrationId
  );
  await vscode.workspace.fs.createDirectory(migrationRoot);

  const yamlUri = vscode.Uri.joinPath(migrationRoot, "migration.yaml");
  const upUri = vscode.Uri.joinPath(migrationRoot, "up.sql");
  const downUri = vscode.Uri.joinPath(migrationRoot, "down.sql");
  const impactUri = vscode.Uri.joinPath(migrationRoot, "impact.json");
  const complianceUri = vscode.Uri.joinPath(migrationRoot, "compliance.json");
  const indexUri = vscode.Uri.joinPath(migrationRoot, "migration.json");

  await writeTextFile(yamlUri, plan.artifacts.migrationYaml);
  await writeTextFile(upUri, ensureTrailingNewline(plan.artifacts.upSql));
  await writeTextFile(downUri, ensureTrailingNewline(plan.artifacts.downSql));
  await writeTextFile(impactUri, ensureTrailingNewline(plan.artifacts.impactJson));
  await writeTextFile(complianceUri, ensureTrailingNewline(plan.artifacts.complianceJson));

  const index = {
    id: plan.id,
    title: plan.title,
    environment: plan.environment,
    engine: plan.engine,
    artifacts: {
      yaml: "migration.yaml",
      up: "up.sql",
      down: "down.sql",
      impact: "impact.json",
      compliance: "compliance.json",
    },
  };
  await writeTextFile(indexUri, `${JSON.stringify(index, null, 2)}\n`);

  vscode.window.showInformationMessage(
    `DB Copilot: Migration saved to ${migrationRoot.fsPath}.`
  );
}

async function executeDbCopilotMigrationPlan(
  context: vscode.ExtensionContext,
  tokenStore: ReturnType<typeof createTokenStore>,
  output: vscode.OutputChannel,
  statusBars: StatusBarItems,
  sidebarProvider?: SidebarProvider
): Promise<void> {
  const plan = resolveDbCopilotMigrationPlan(context);
  if (!plan) {
    vscode.window.showWarningMessage("DB Copilot: No migration plan to execute.");
    return;
  }
  const gate = evaluateDbCopilotMigrationExecutionGate(plan);
  if (!gate.allowed) {
    vscode.window.showWarningMessage(`DB Copilot: ${gate.reasons[0]}`);
    return;
  }

  const statements = splitSqlStatements(plan.artifacts.upSql);
  if (!statements.length) {
    vscode.window.showWarningMessage("DB Copilot: No SQL statements to execute.");
    return;
  }

  const topRisks = buildDbCopilotMigrationTopRisks(plan);
  const detail = [
    `Environment: ${formatDbCopilotEnvironment(plan.environment)}`,
    `Statements: ${statements.length}`,
    "Top risks:",
    ...topRisks.map((risk) => `- ${risk}`),
  ].join("\n");
  const confirmation = await vscode.window.showWarningMessage(
    "DB Copilot: Execute migration plan?",
    { modal: true, detail },
    "Execute"
  );
  if (confirmation !== "Execute") {
    return;
  }

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
      "DB Copilot: Select a connection before executing migrations."
    );
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

  DbCopilotLogsView.show(context);
  streamDbCopilotLogs([
    buildDbCopilotLogEntry(
      "execution",
      `Starting migration ${plan.id} (${statements.length} statements).`
    ),
  ]);

  const requestBase = {
    projectId: workspaceContext.projectId,
    connectionId: workspaceContext.connectionId ?? undefined,
    source: "vscode" as const,
    client: {
      extensionVersion: getExtensionVersion(context),
      vscodeVersion: vscode.version,
    },
  };

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const summary = summarizeSql(statement);
    appendDbCopilotLogEntry(
      buildDbCopilotLogEntry(
        "execution",
        `Executing ${index + 1}/${statements.length}: ${summary}`
      )
    );
    const startedAt = Date.now();
    try {
      const response = await executeQuery(client, {
        ...requestBase,
        sql: statement,
      });
      if (response.error) {
        const errorMessage = response.error.message ?? "Execution failed.";
        appendDbCopilotLogEntry(
          buildDbCopilotLogEntry(
            "execution",
            `Statement ${index + 1} failed: ${errorMessage}`
          )
        );
        appendDbCopilotLogEntry(
          buildDbCopilotLogEntry(
            "execution",
            "Rollback suggested: review down.sql for this migration."
          )
        );
        vscode.window.showErrorMessage(
          `DB Copilot: Migration failed on statement ${index + 1}.`
        );
        return;
      }
      const duration = Date.now() - startedAt;
      appendDbCopilotLogEntry(
        buildDbCopilotLogEntry(
          "execution",
          `Statement ${index + 1} completed in ${duration}ms.`
        )
      );
    } catch (err) {
      appendDbCopilotLogEntry(
        buildDbCopilotLogEntry(
          "execution",
          `Statement ${index + 1} failed: ${formatRequestError(err)}`
        )
      );
      appendDbCopilotLogEntry(
        buildDbCopilotLogEntry(
          "execution",
          "Rollback suggested: review down.sql for this migration."
        )
      );
      reportRequestError(output, "Migration execution failed", err);
      return;
    }
  }

  appendDbCopilotLogEntry(
    buildDbCopilotLogEntry("execution", "Migration execution completed.")
  );
  dbCopilotSchemaRefreshScheduler?.schedule();
  vscode.window.showInformationMessage("DB Copilot: Migration executed successfully.");
}

async function exportDbCopilotErdPng(
  dataUrl: string,
  snapshot: DbCopilotSchemaSnapshot | null
): Promise<void> {
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    vscode.window.showErrorMessage("DB Copilot: Invalid PNG payload.");
    return;
  }
  const buffer = Buffer.from(match[1], "base64");
  const fileName = snapshot ? `${snapshot.schema}-erd.png` : "schema-erd.png";
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder, fileName)
    : undefined;

  const destination = await vscode.window.showSaveDialog({
    filters: { PNG: ["png"] },
    defaultUri,
    title: "Export ER diagram",
  });
  if (!destination) {
    return;
  }
  await vscode.workspace.fs.writeFile(destination, buffer);
  vscode.window.showInformationMessage(
    `DB Copilot: ER diagram exported to ${destination.fsPath}.`
  );
}

function openDbCopilotPlaceholderPanel(viewType: string, spec: DbCopilotPanelSpec): void {
  let panel = dbCopilotPanels.get(viewType);
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      viewType,
      spec.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      dbCopilotPanels.delete(viewType);
    });
    dbCopilotPanels.set(viewType, panel);
  }

  panel.title = spec.title;
  panel.webview.html = buildDbCopilotPlaceholderHtml(spec);
  panel.reveal(vscode.ViewColumn.Active, true);
}

function buildDbCopilotPlaceholderHtml(spec: DbCopilotPanelSpec): string {
  const escapedTitle = escapeHtml(spec.title);
  const escapedDescription = escapeHtml(spec.description);
  const bullets =
    spec.bullets && spec.bullets.length > 0
      ? `<ul>${spec.bullets
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
    }
    .card {
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 10px;
      padding: 20px;
      max-width: 720px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    }
    h1 {
      font-size: 20px;
      margin: 0 0 8px;
    }
    p {
      margin: 0 0 12px;
      color: var(--vscode-descriptionForeground);
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li {
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapedTitle}</h1>
    <p>${escapedDescription}</p>
    ${bullets}
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function openDbCopilotPolicies(): Promise<void> {
  const content = [
    "# DB Copilot Policies",
    "",
    ...DBCOPILOT_POLICY_NOTES.map((note) => `- ${note}`),
    "",
  ].join("\n");

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  return typeof version === "string" ? version : "0.0.0";
}

function createNonce(): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}
