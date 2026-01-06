import * as vscode from "vscode";
import type { ApiClient } from "../../api/client";
import { formatApiError } from "../../api/client";
import { listColumns, listConnections, listSchemas, listTables } from "../../api/endpoints";
import type {
  SchemaColumnResource,
  SchemaResource,
  SchemaTableResource,
} from "../../api/types";
import { getWorkspaceContext } from "../../state/workspaceState";
import type { TokenStore } from "../../auth/tokenStore";
import {
  ActionNode,
  ColumnNode,
  ColumnsRootNode,
  ConnectionNode,
  ErrorNode,
  type DbExplorerNode,
  SchemaNode,
  SchemasRootNode,
  TableNode,
} from "./nodes";

type AuthContext = { baseUrl: string; token: string };

type ProviderDependencies = {
  context: vscode.ExtensionContext;
  tokenStore: TokenStore;
  output: vscode.OutputChannel;
  resolveAuthContext: () => Promise<AuthContext | null>;
  createAuthorizedClient: (auth: AuthContext) => ApiClient;
};

const CACHE_TTL_MS = 60_000;

export class DbExplorerProvider implements vscode.TreeDataProvider<DbExplorerNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    DbExplorerNode | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private treeView?: vscode.TreeView<DbExplorerNode>;

  constructor(private readonly deps: ProviderDependencies) {}

  attachView(view: vscode.TreeView<DbExplorerNode>): void {
    this.treeView = view;
  }

  refresh(node?: DbExplorerNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getParent(element: DbExplorerNode): DbExplorerNode | undefined {
    return element.parent;
  }

  getTreeItem(element: DbExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbExplorerNode): Promise<DbExplorerNode[]> {
    if (!element) {
      return this.getRootNodes();
    }

    switch (element.kind) {
      case "connection":
        return [new SchemasRootNode(element.connection.id, element)];
      case "schemasRoot":
        return this.loadSchemas(element);
      case "schema":
        return this.loadTables(element);
      case "table":
        return [new ColumnsRootNode(element.connectionId, element.schemaName, element.table.name, element)];
      case "columnsRoot":
        return this.loadColumns(element);
      default:
        return [];
    }
  }

  async revealTable(schemaName: string, tableName: string): Promise<boolean> {
    if (!this.treeView) {
      return false;
    }

    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.connectionId) {
      return false;
    }

    const connectionNode = new ConnectionNode({
      id: workspace.connectionId,
      project_id: workspace.projectId ?? "",
      type: "postgres",
      name: "Connection",
      ssl_mode: "unknown",
      host: null,
      port: null,
      database: null,
      username: null,
      uses_url: false,
      has_password: false,
      created_at: "",
      updated_at: "",
    });

    const schemasRoot = new SchemasRootNode(workspace.connectionId, connectionNode);
    const schemaNode = new SchemaNode(workspace.connectionId, schemaName, schemasRoot);
    const tableNode = new TableNode(
      workspace.connectionId,
      schemaName,
      { name: tableName, type: "table" },
      schemaNode
    );

    try {
      await this.treeView.reveal(tableNode, { select: true, focus: true, expand: true });
      return true;
    } catch {
      return false;
    }
  }

  async getSchemasForSearch(): Promise<SchemaResource[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId || !workspace.connectionId) {
      return null;
    }
    const client = this.deps.createAuthorizedClient(auth);
    return this.fetchSchemas(client, workspace.projectId, workspace.connectionId);
  }

  async getTablesForSearch(schemaName: string): Promise<SchemaTableResource[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId || !workspace.connectionId) {
      return null;
    }
    const client = this.deps.createAuthorizedClient(auth);
    return this.fetchTables(client, workspace.projectId, workspace.connectionId, schemaName);
  }

  private async getRootNodes(): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    const token = await this.deps.tokenStore.getAccessToken();

    if (!token) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login")];
    }

    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject")];
    }

    if (!workspace.connectionId) {
      return [new ActionNode("Select Connection", "sqlcortex.selectConnection")];
    }

    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login")];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const connections = await this.withProgress("Loading connections...", () =>
        listConnections(client, workspace.projectId)
      );
      const connection = connections.find((item) => item.id === workspace.connectionId);
      if (!connection) {
        return [new ActionNode("Select Connection", "sqlcortex.selectConnection")];
      }
      return [new ConnectionNode(connection)];
    } catch (err) {
      this.logError("Failed to load connections", err);
      return [new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer")];
    }
  }

  private async loadSchemas(element: SchemasRootNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const schemas = await this.withProgress("Loading schemas...", () =>
        this.fetchSchemas(client, workspace.projectId, element.connectionId)
      );
      if (schemas.length === 0) {
        return [new ErrorNode("No schemas found.", "sqlcortex.refreshExplorer", element)];
      }
      return schemas.map(
        (schema) => new SchemaNode(element.connectionId, schema.name, element)
      );
    } catch (err) {
      this.logError("Failed to load schemas", err);
      return [new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element)];
    }
  }

  private async loadTables(element: SchemaNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const tables = await this.withProgress("Loading tables...", () =>
        this.fetchTables(client, workspace.projectId, element.connectionId, element.schemaName)
      );
      if (tables.length === 0) {
        return [new ErrorNode("No tables or views found.", "sqlcortex.refreshExplorer", element)];
      }
      return tables.map(
        (table) => new TableNode(element.connectionId, element.schemaName, table, element)
      );
    } catch (err) {
      this.logError("Failed to load tables", err);
      return [new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element)];
    }
  }

  private async loadColumns(element: ColumnsRootNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const columns = await this.withProgress("Loading columns...", () =>
        this.fetchColumns(
          client,
          workspace.projectId,
          element.connectionId,
          element.schemaName,
          element.tableName
        )
      );
      if (columns.length === 0) {
        return [new ErrorNode("No columns found.", "sqlcortex.refreshExplorer", element)];
      }
      return columns.map(
        (column) =>
          new ColumnNode(
            element.connectionId,
            element.schemaName,
            element.tableName,
            column,
            element
          )
      );
    } catch (err) {
      this.logError("Failed to load columns", err);
      return [new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element)];
    }
  }

  private async fetchSchemas(
    client: ApiClient,
    projectId: string,
    connectionId: string
  ): Promise<SchemaResource[]> {
    const cacheKey = this.cacheKey(connectionId, "schemas");
    return this.fetchWithCache(cacheKey, () => listSchemas(client, projectId, connectionId));
  }

  private async fetchTables(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string
  ): Promise<SchemaTableResource[]> {
    const cacheKey = this.cacheKey(connectionId, "tables", { schema: schemaName });
    return this.fetchWithCache(cacheKey, () =>
      listTables(client, projectId, connectionId, schemaName)
    );
  }

  private async fetchColumns(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<SchemaColumnResource[]> {
    const cacheKey = this.cacheKey(connectionId, "columns", {
      schema: schemaName,
      table: tableName,
    });
    return this.fetchWithCache(cacheKey, () =>
      listColumns(client, projectId, connectionId, schemaName, tableName)
    );
  }

  private cacheKey(
    connectionId: string,
    endpoint: string,
    params?: Record<string, string>
  ): string {
    const normalizedParams = params
      ? Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join("&")
      : "";
    return `${connectionId}:${endpoint}:${normalizedParams}`;
  }

  private getCachedValue<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return cached.value as T;
  }

  private setCachedValue(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private async fetchWithCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.getCachedValue<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await loader();
    this.setCachedValue(key, value);
    return value;
  }

  private async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);
  }

  private logError(label: string, err: unknown): void {
    const message = formatApiError(err);
    this.deps.output.appendLine(`SQLCortex: ${label}: ${message}`);
  }
}
