import type { ApiClient } from "./client";
import type { ExecuteQueryRequest, ExecuteQueryResponse, Org, Project } from "./types";

type OrgListResponse = {
  orgs?: Org[];
};

type ProjectListResponse = {
  projects?: Project[];
};

export async function listOrgs(client: ApiClient): Promise<Org[]> {
  const payload = await client.get<OrgListResponse>("/api/v1/orgs");
  return payload.orgs ?? [];
}

export async function listProjects(client: ApiClient): Promise<Project[]> {
  const payload = await client.get<ProjectListResponse>("/api/v1/projects");
  return payload.projects ?? [];
}

export async function executeQuery(
  client: ApiClient,
  request: ExecuteQueryRequest
): Promise<ExecuteQueryResponse> {
  return client.post<ExecuteQueryResponse>("/api/v1/query/execute", request);
}
