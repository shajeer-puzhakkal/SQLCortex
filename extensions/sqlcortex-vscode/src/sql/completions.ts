import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import { formatApiError } from "../api/client";
import { listColumns, listSchemas, listTables } from "../api/endpoints";
import type { SchemaColumnResource, SchemaTableResource } from "../api/types";
import { getWorkspaceContext } from "../state/workspaceState";

type AuthContext = { baseUrl: string; token: string };

type CompletionDependencies = {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  resolveAuthContext: () => Promise<AuthContext | null>;
  createClient: (auth: AuthContext) => ApiClient;
};

const CACHE_TTL_MS = 60_000;
const IDENTIFIER_PATTERN = "[A-Za-z_][\\w$]*";
const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "ALTER",
  "DROP",
  "VALUES",
  "WITH",
  "UNION",
  "EXISTS",
];

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly keywordItems = SQL_KEYWORDS.map((keyword) => {
    const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
    item.insertText = keyword;
    return item;
  });

  constructor(private readonly deps: CompletionDependencies) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!this.shouldProvideForDocument(document)) {
      return undefined;
    }

    const workspace = getWorkspaceContext(this.deps.context);
    if (!workspace.projectId || !workspace.connectionId) {
      return this.keywordItems;
    }

    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const schemaTableMatch = new RegExp(
      `(${IDENTIFIER_PATTERN})\\.(${IDENTIFIER_PATTERN})\\.$`
    ).exec(linePrefix);
    if (schemaTableMatch) {
      const [, schemaName, tableName] = schemaTableMatch;
      const columns = await this.getColumns(workspace.projectId, workspace.connectionId, schemaName, tableName);
      return columns?.map((column) => this.toColumnItem(column)) ?? this.keywordItems;
    }

    const schemaMatch = new RegExp(`(${IDENTIFIER_PATTERN})\\.$`).exec(linePrefix);
    if (schemaMatch) {
      const [, schemaName] = schemaMatch;
      const schemas = await this.getSchemas(workspace.projectId, workspace.connectionId);
      if (!schemas) {
        return this.keywordItems;
      }
      const schemaExists = schemas.some((schema) => schema.name === schemaName);
      if (!schemaExists) {
        return this.keywordItems;
      }
      const tables = await this.getTablesBySchema(
        workspace.projectId,
        workspace.connectionId,
        schemaName
      );
      return tables?.map((table) => this.toTableItem(table)) ?? this.keywordItems;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const schemas = await this.getSchemas(workspace.projectId, workspace.connectionId);
    if (!schemas) {
      return this.keywordItems;
    }

    const tableItems = await this.getTableItems(
      workspace.projectId,
      workspace.connectionId,
      schemas,
      token
    );

    const schemaItems = schemas.map((schema) => {
      const item = new vscode.CompletionItem(schema.name, vscode.CompletionItemKind.Module);
      item.detail = "schema";
      return item;
    });

    return [...this.keywordItems, ...schemaItems, ...tableItems];
  }

  private shouldProvideForDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme === "untitled" && document.languageId === "plaintext") {
      return true;
    }
    return document.languageId === "sql";
  }

  private async getSchemas(
    projectId: string,
    connectionId: string
  ): Promise<{ name: string }[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const client = this.deps.createClient(auth);
    const cacheKey = `${projectId}:${connectionId}:schemas`;
    try {
      return await this.fetchWithCache(cacheKey, () =>
        listSchemas(client, projectId, connectionId)
      );
    } catch {
      return null;
    }
  }

  private async getTablesBySchema(
    projectId: string,
    connectionId: string,
    schemaName: string
  ): Promise<SchemaTableResource[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const client = this.deps.createClient(auth);
    const cacheKey = `${projectId}:${connectionId}:tables:${schemaName}`;
    try {
      return await this.fetchWithCache(cacheKey, () =>
        listTables(client, projectId, connectionId, schemaName)
      );
    } catch {
      return null;
    }
  }

  private async getColumns(
    projectId: string,
    connectionId: string,
    schemaName: string,
    tableName: string
  ): Promise<SchemaColumnResource[] | null> {
    const auth = await this.deps.resolveAuthContext();
    if (!auth) {
      return null;
    }
    const client = this.deps.createClient(auth);
    const cacheKey = `${projectId}:${connectionId}:columns:${schemaName}:${tableName}`;
    try {
      return await this.fetchWithCache(cacheKey, () =>
        listColumns(client, projectId, connectionId, schemaName, tableName)
      );
    } catch {
      return null;
    }
  }

  private async getTableItems(
    projectId: string,
    connectionId: string,
    schemas: { name: string }[],
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    const results: vscode.CompletionItem[] = [];
    for (const schema of schemas) {
      if (token.isCancellationRequested) {
        break;
      }
      const tables = await this.getTablesBySchema(projectId, connectionId, schema.name);
      if (!tables) {
        continue;
      }
      for (const table of tables) {
        const item = this.toTableItem(table);
        item.label = `${schema.name}.${table.name}`;
        item.insertText = `${schema.name}.${table.name}`;
        results.push(item);
      }
    }
    return results;
  }

  private toTableItem(table: SchemaTableResource): vscode.CompletionItem {
    const kind =
      table.type === "view" ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class;
    const item = new vscode.CompletionItem(table.name, kind);
    item.detail = table.type;
    return item;
  }

  private toColumnItem(column: SchemaColumnResource): vscode.CompletionItem {
    const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
    item.detail = column.type;
    return item;
  }

  private async fetchWithCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.getCachedValue<T>(key);
    if (cached !== null) {
      return cached;
    }
    try {
      const value = await loader();
      this.setCachedValue(key, value);
      return value;
    } catch (err) {
      this.logError("Completion data fetch failed", err);
      throw err;
    }
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

  private logError(label: string, err: unknown): void {
    const message = formatApiError(err);
    this.deps.output.appendLine(`SQLCortex: ${label}: ${message}`);
  }
}
