import type { ApiClient } from "./client";
import type {
  ConnectionResource,
  ExecuteQueryRequest,
  ExecuteQueryResponse,
  Org,
  Project,
  SchemaColumnResource,
  SchemaResource,
  SchemaTableResource,
} from "./types";

type OrgListResponse = {
  orgs?: Org[];
};

type ProjectListResponse = {
  projects?: Project[];
};

type ConnectionListResponse = {
  connections?: ConnectionResource[];
};

type SchemaListResponse = {
  schemas?: SchemaResource[];
};

type TableListResponse = {
  schema: string;
  tables: SchemaTableResource[];
};

type ColumnListResponse = {
  schema: string;
  table: string;
  columns: SchemaColumnResource[];
};

export async function listOrgs(client: ApiClient): Promise<Org[]> {
  const payload = await client.get<OrgListResponse>("/api/v1/orgs");
  return payload.orgs ?? [];
}

export async function listProjects(client: ApiClient): Promise<Project[]> {
  const payload = await client.get<ProjectListResponse>("/api/v1/projects");
  return payload.projects ?? [];
}

export async function listConnections(
  client: ApiClient,
  projectId: string
): Promise<ConnectionResource[]> {
  const payload = await client.get<ConnectionListResponse>(
    `/api/v1/projects/${projectId}/connections`
  );
  return payload.connections ?? [];
}

export async function listSchemas(
  client: ApiClient,
  projectId: string,
  connectionId: string,
  options?: { includeSystem?: boolean }
): Promise<SchemaResource[]> {
  const query = options?.includeSystem ? "?includeSystem=true" : "";
  const payload = await client.get<SchemaListResponse>(
    `/api/v1/projects/${projectId}/connections/${connectionId}/schema/schemas${query}`
  );
  return payload.schemas ?? [];
}

export async function listTables(
  client: ApiClient,
  projectId: string,
  connectionId: string,
  schemaName: string
): Promise<SchemaTableResource[]> {
  const encodedSchema = encodeURIComponent(schemaName);
  const payload = await client.get<TableListResponse>(
    `/api/v1/projects/${projectId}/connections/${connectionId}/schema/tables?schema=${encodedSchema}`
  );
  return payload.tables ?? [];
}

export async function listColumns(
  client: ApiClient,
  projectId: string,
  connectionId: string,
  schemaName: string,
  tableName: string
): Promise<SchemaColumnResource[]> {
  const encodedSchema = encodeURIComponent(schemaName);
  const encodedTable = encodeURIComponent(tableName);
  const payload = await client.get<ColumnListResponse>(
    `/api/v1/projects/${projectId}/connections/${connectionId}/schema/columns?schema=${encodedSchema}&table=${encodedTable}`
  );
  return payload.columns ?? [];
}

export async function executeQuery(
  client: ApiClient,
  request: ExecuteQueryRequest
): Promise<ExecuteQueryResponse> {
  return client.post<ExecuteQueryResponse>("/api/v1/query/execute", request);
}
