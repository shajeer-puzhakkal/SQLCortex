import * as vscode from "vscode";
import type { ApiClient } from "../../api/client";
import { formatApiError } from "../../api/client";
import {
  executeQuery,
  getSchemaMetadata,
  listColumns,
  listConnections,
  listSchemas,
  listTables,
} from "../../api/endpoints";
import type {
  ForeignKeyInfo,
  IndexInfo,
  SchemaColumnResource,
  SchemaMetadataResponse,
  SchemaResource,
  SchemaTableResource,
  TableInfo,
} from "../../api/types";
import { getWorkspaceContext } from "../../state/workspaceState";
import type { TokenStore } from "../../auth/tokenStore";
import {
  ActionNode,
  ColumnNode,
  ColumnsRootNode,
  ConnectionNode,
  ConstraintNode,
  ConstraintsRootNode,
  ErrorNode,
  InfoNode,
  IndexNode,
  IndexesRootNode,
  type DbExplorerNode,
  RelationshipNode,
  RelationshipsRootNode,
  SchemaNode,
  SchemaSectionNode,
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

export type TableConstraintInfo = {
  name: string;
  type: string;
  summary?: string;
  tooltip?: string;
  icon?: string;
};

export class DbExplorerProvider implements vscode.TreeDataProvider<DbExplorerNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    DbExplorerNode | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly schemaMetadataPromises = new Map<string, Promise<SchemaMetadataResponse>>();
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
    this.schemaMetadataPromises.clear();
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
        return [
          new SchemaSectionNode(element.connectionId, element.schemaName, "tables", element),
          new SchemaSectionNode(element.connectionId, element.schemaName, "views", element),
          new SchemaSectionNode(element.connectionId, element.schemaName, "functions", element),
        ];
      case "schemaSection":
        return this.loadSchemaSection(element);
      case "table":
        return this.getTableChildren(element);
      case "columnsRoot":
        return this.loadColumns(element);
      case "relationshipsRoot":
        return this.loadRelationships(element);
      case "indexesRoot":
        return this.loadIndexes(element);
      case "constraintsRoot":
        return this.loadConstraints(element);
      default:
        return [];
    }
  }

  async revealTable(
    schemaName: string,
    tableName: string,
    tableType: "table" | "view" = "table"
  ): Promise<boolean> {
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
      name: workspace.connectionName ?? "Connection",
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
    const sectionNode = new SchemaSectionNode(
      workspace.connectionId,
      schemaName,
      tableType === "view" ? "views" : "tables",
      schemaNode
    );
    const tableNode = new TableNode(
      workspace.connectionId,
      schemaName,
      { name: tableName, type: tableType },
      sectionNode
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

  async getTableConstraints(
    schemaName: string,
    tableName: string
  ): Promise<TableConstraintInfo[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId || !workspace.connectionId) {
      return null;
    }
    const client = this.deps.createAuthorizedClient(auth);
    return this.fetchConstraints(
      client,
      workspace.projectId,
      workspace.connectionId,
      schemaName,
      tableName
    );
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

    const projectId = workspace.projectId;
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
        listConnections(client, projectId)
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

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const schemas = await this.withProgress("Loading schemas...", () =>
        this.fetchSchemas(client, projectId, element.connectionId)
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

  private async loadSchemaSection(element: SchemaSectionNode): Promise<DbExplorerNode[]> {
    if (element.sectionType === "functions") {
      return this.loadFunctions(element);
    }

    const tableType = element.sectionType === "views" ? "view" : "table";
    return this.loadTablesByType(element, tableType);
  }

  private async loadTablesByType(
    element: SchemaSectionNode,
    tableType: "table" | "view"
  ): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    const label = tableType === "view" ? "views" : "tables";
    try {
      const tables = await this.withProgress(`Loading ${label}...`, () =>
        this.fetchTables(client, projectId, element.connectionId, element.schemaName)
      );
      this.prefetchSchemaMetadata(
        client,
        projectId,
        element.connectionId,
        element.schemaName
      );
      const filtered = tables.filter((table) => table.type === tableType);
      if (filtered.length === 0) {
        return [new InfoNode(`No ${label} found.`, element)];
      }
      return filtered.map(
        (table) => new TableNode(element.connectionId, element.schemaName, table, element)
      );
    } catch (err) {
      const errorLabel = tableType === "view" ? "Failed to load views" : "Failed to load tables";
      this.logError(errorLabel, err);
      return [
        new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element),
      ];
    }
  }

  private async loadFunctions(element: SchemaSectionNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    return [new InfoNode("Functions not available yet.", element)];
  }

  private async loadColumns(element: ColumnsRootNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const columns = await this.withProgress("Loading columns...", () =>
        this.fetchColumns(
          client,
          projectId,
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

  private async loadRelationships(
    element: RelationshipsRootNode
  ): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const relationships = await this.withProgress("Loading relationships...", () =>
        this.fetchRelationships(
          client,
          projectId,
          element.connectionId,
          element.schemaName,
          element.tableName
        )
      );

      if (relationships.length === 0) {
        return [new InfoNode("No relationships found.", element)];
      }

      return relationships.map((relationship) => {
        const info = this.formatRelationshipInfo(relationship);
        return new RelationshipNode(info, element);
      });
    } catch (err) {
      this.logError("Failed to load relationships", err);
      return [
        new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element),
      ];
    }
  }

  private async loadIndexes(element: IndexesRootNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const indexes = await this.withProgress("Loading indexes...", () =>
        this.fetchIndexes(
          client,
          projectId,
          element.connectionId,
          element.schemaName,
          element.tableName
        )
      );

      if (indexes.length === 0) {
        return [new InfoNode("No indexes found.", element)];
      }

      return indexes.map((index) => {
        const info = this.formatIndexInfo(index);
        return new IndexNode(info, element);
      });
    } catch (err) {
      this.logError("Failed to load indexes", err);
      return [
        new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element),
      ];
    }
  }

  private getTableChildren(element: TableNode): DbExplorerNode[] {
    const nodes: DbExplorerNode[] = [
      new ColumnsRootNode(
        element.connectionId,
        element.schemaName,
        element.table.name,
        element
      ),
    ];

    if (element.table.type !== "view") {
      nodes.push(
        new RelationshipsRootNode(
          element.connectionId,
          element.schemaName,
          element.table.name,
          element
        ),
        new IndexesRootNode(
          element.connectionId,
          element.schemaName,
          element.table.name,
          element
        ),
        new ConstraintsRootNode(
          element.connectionId,
          element.schemaName,
          element.table.name,
          element
        )
      );
    }

    return nodes;
  }

  private async loadConstraints(element: ConstraintsRootNode): Promise<DbExplorerNode[]> {
    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId) {
      return [new ActionNode("Select Project", "sqlcortex.selectProject", element)];
    }

    const projectId = workspace.projectId;
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return [new ActionNode("Sign in to SQLCortex", "sqlcortex.login", element)];
    }

    const client = this.deps.createAuthorizedClient(auth);
    try {
      const constraints = await this.withProgress("Loading constraints...", () =>
        this.fetchConstraints(
          client,
          projectId,
          element.connectionId,
          element.schemaName,
          element.tableName
        )
      );

      if (constraints.length === 0) {
        return [new InfoNode("No constraints found.", element)];
      }

      return constraints.map((constraint) => new ConstraintNode(constraint, element));
    } catch (err) {
      this.logError("Failed to load constraints", err);
      return [
        new ErrorNode("Failed to load. Click to retry.", "sqlcortex.refreshExplorer", element),
      ];
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

  private async fetchSchemaMetadata(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string
  ): Promise<SchemaMetadataResponse> {
    const cacheKey = this.cacheKey(connectionId, "schemaMetadata", { schema: schemaName });
    const cached = this.getCachedValue<SchemaMetadataResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.schemaMetadataPromises.get(cacheKey);
    if (pending) {
      return pending;
    }

    const promise = getSchemaMetadata(client, projectId, connectionId, schemaName)
      .then((metadata) => {
        this.setCachedValue(cacheKey, metadata);
        return metadata;
      })
      .finally(() => {
        this.schemaMetadataPromises.delete(cacheKey);
      });

    this.schemaMetadataPromises.set(cacheKey, promise);
    return promise;
  }

  private prefetchSchemaMetadata(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string
  ): void {
    void this.fetchSchemaMetadata(client, projectId, connectionId, schemaName).catch(
      (err) => {
        this.logError("Failed to preload schema metadata", err);
      }
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
    return this.fetchWithCache(cacheKey, async () => {
      const metadata = await this.fetchSchemaMetadata(
        client,
        projectId,
        connectionId,
        schemaName
      ).catch(() => null);
      const tableInfo = metadata?.tables.find((table) => table.name === tableName);
      if (tableInfo) {
        return tableInfo.columns;
      }
      return listColumns(client, projectId, connectionId, schemaName, tableName);
    });
  }

  private async fetchTableInfo(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<TableInfo | null> {
    const metadata = await this.fetchSchemaMetadata(
      client,
      projectId,
      connectionId,
      schemaName
    );
    return metadata.tables.find((table) => table.name === tableName) ?? null;
  }

  private async fetchRelationships(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<ForeignKeyInfo[]> {
    const tableInfo = await this.fetchTableInfo(
      client,
      projectId,
      connectionId,
      schemaName,
      tableName
    );
    return tableInfo?.foreignKeys ?? [];
  }

  private async fetchIndexes(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<IndexInfo[]> {
    const tableInfo = await this.fetchTableInfo(
      client,
      projectId,
      connectionId,
      schemaName,
      tableName
    );
    return tableInfo?.indexes ?? [];
  }

  private async fetchConstraints(
    client: ApiClient,
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<TableConstraintInfo[]> {
    const cacheKey = this.cacheKey(connectionId, "constraints", {
      schema: schemaName,
      table: tableName,
    });

    return this.fetchWithCache(cacheKey, async () => {
      const sql = this.buildConstraintsQuery(schemaName, tableName);
      const response = await executeQuery(client, {
        projectId,
        connectionId,
        sql,
        source: "vscode",
        client: {
          extensionVersion: this.getExtensionVersion(),
          vscodeVersion: vscode.version,
        },
      });

      if (response.error) {
        const reason = this.extractErrorReason(response.error.details);
        const message = response.error.message ?? "Failed to load constraints.";
        throw new Error(reason ? `${message} (${reason})` : message);
      }

      return this.parseConstraintRows(response.columns, response.rows);
    });
  }

  private formatRelationshipInfo(foreignKey: ForeignKeyInfo): {
    name: string;
    summary: string;
    tooltip?: string;
    icon?: string;
  } {
    const localColumns =
      foreignKey.columns.length > 0 ? `(${foreignKey.columns.join(", ")})` : "";
    const foreignColumns =
      foreignKey.foreignColumns.length > 0
        ? `(${foreignKey.foreignColumns.join(", ")})`
        : "";
    const foreignTable = `${foreignKey.foreignSchema}.${foreignKey.foreignTable}${foreignColumns}`;
    const direction = localColumns ? `${localColumns} -> ${foreignTable}` : `-> ${foreignTable}`;
    const onDelete = foreignKey.onDelete?.trim() || "NO ACTION";
    const onUpdate = foreignKey.onUpdate?.trim() || "NO ACTION";
    const summary = `${direction} | ON DELETE ${onDelete}, ON UPDATE ${onUpdate}`;
    return { name: foreignKey.name, summary, tooltip: summary, icon: "link" };
  }

  private formatIndexInfo(index: IndexInfo): {
    name: string;
    summary: string;
    tooltip?: string;
    icon?: string;
  } {
    const summaryParts: string[] = [];
    if (index.primary) {
      summaryParts.push("primary");
    } else if (index.unique) {
      summaryParts.push("unique");
    } else {
      summaryParts.push("index");
    }
    const method = index.method?.trim();
    if (method) {
      summaryParts.push(method);
    }
    let summary = summaryParts.join(" ");
    if (index.columns.length > 0) {
      summary = `${summary} (${index.columns.join(", ")})`;
    }
    const predicate = index.predicate?.trim();
    if (predicate) {
      summary = `${summary} WHERE ${predicate}`;
    }
    const icon = index.primary || index.unique ? "key" : undefined;
    return { name: index.name, summary, tooltip: summary, icon };
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

  private buildConstraintsQuery(schemaName: string, tableName: string): string {
    const schemaLiteral = this.escapeSqlLiteral(schemaName);
    const tableLiteral = this.escapeSqlLiteral(tableName);
    return `
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = '${schemaLiteral}'
        AND tc.table_name = '${tableLiteral}'
      ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position;
    `.trim();
  }

  private parseConstraintRows(
    columns: Array<{ name: string }>,
    rows: Array<Array<unknown>>
  ): Array<{ name: string; type: string; summary?: string; tooltip?: string; icon?: string }> {
    const indexByName = new Map<string, number>();
    columns.forEach((col, index) => {
      indexByName.set(col.name, index);
    });

    const nameIndex = indexByName.get("constraint_name");
    const typeIndex = indexByName.get("constraint_type");
    const columnIndex = indexByName.get("column_name");
    const foreignSchemaIndex = indexByName.get("foreign_table_schema");
    const foreignTableIndex = indexByName.get("foreign_table_name");
    const foreignColumnIndex = indexByName.get("foreign_column_name");

    if (nameIndex === undefined || typeIndex === undefined) {
      return [];
    }

    const constraints = new Map<
      string,
      {
        name: string;
        type: string;
        columns: string[];
        foreignTable?: string;
        foreignColumns: string[];
      }
    >();
    const order: string[] = [];

    for (const row of rows) {
      const name = this.asString(row[nameIndex]);
      if (!name) {
        continue;
      }
      const type = this.asString(row[typeIndex]) ?? "CONSTRAINT";
      let entry = constraints.get(name);
      if (!entry) {
        entry = { name, type, columns: [], foreignColumns: [] };
        constraints.set(name, entry);
        order.push(name);
      }

      const columnName = columnIndex !== undefined ? this.asString(row[columnIndex]) : null;
      if (columnName) {
        this.pushUnique(entry.columns, columnName);
      }

      const foreignSchema =
        foreignSchemaIndex !== undefined ? this.asString(row[foreignSchemaIndex]) : null;
      const foreignTable =
        foreignTableIndex !== undefined ? this.asString(row[foreignTableIndex]) : null;
      if (foreignSchema && foreignTable) {
        entry.foreignTable = `${foreignSchema}.${foreignTable}`;
      }

      const foreignColumn =
        foreignColumnIndex !== undefined ? this.asString(row[foreignColumnIndex]) : null;
      if (foreignColumn) {
        this.pushUnique(entry.foreignColumns, foreignColumn);
      }
    }

    return order
      .map((name) => constraints.get(name))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((entry) => {
        const summaryParts = [entry.type];
        if (entry.columns.length > 0) {
          summaryParts.push(`(${entry.columns.join(", ")})`);
        }
        if (entry.type === "FOREIGN KEY" && entry.foreignTable) {
          const foreignColumns =
            entry.foreignColumns.length > 0 ? `(${entry.foreignColumns.join(", ")})` : "";
          summaryParts.push(`→ ${entry.foreignTable}${foreignColumns}`);
        }

        const summary = summaryParts.join(" ");
        return {
          name: entry.name,
          type: entry.type,
          summary,
          tooltip: summary,
          icon: this.iconForConstraint(entry.type),
        };
      });
  }

  private iconForConstraint(type: string): string {
    switch (type.toUpperCase()) {
      case "PRIMARY KEY":
      case "UNIQUE":
        return "key";
      case "FOREIGN KEY":
        return "link";
      case "CHECK":
        return "symbol-constant";
      default:
        return "symbol-misc";
    }
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
  }

  private pushUnique(list: string[], value: string): void {
    if (!list.includes(value)) {
      list.push(value);
    }
  }

  private escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private getExtensionVersion(): string {
    const version = this.deps.context.extension?.packageJSON?.version;
    return typeof version === "string" ? version : "0.0.0";
  }

  private extractErrorReason(details?: Record<string, unknown>): string | null {
    if (!details) {
      return null;
    }
    const reason = details.reason;
    return typeof reason === "string" && reason.trim() ? reason.trim() : null;
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
