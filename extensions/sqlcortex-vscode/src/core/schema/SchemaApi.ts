import type { ApiClient } from "../api/ApiClient";
import { normalizeApiError } from "../errors/normalizeApiError";
import {
  parseSchemaRefreshResponse,
  parseSchemaSnapshot,
  type SchemaRefreshResponse,
  type SchemaSnapshot,
  type SchemaTargetRef,
} from "./SchemaTypes";

const SNAPSHOT_ENDPOINTS = ["/api/v1/schema/snapshot", "/schema/snapshot"] as const;
const REFRESH_ENDPOINTS = ["/api/v1/schema/refresh", "/schema/refresh"] as const;

export class SchemaApi {
  constructor(private readonly client: ApiClient) {}

  async getSnapshot(target: SchemaTargetRef): Promise<SchemaSnapshot> {
    const query = buildTargetQuery(target);
    const payload = await this.requestWithFallback(
      SNAPSHOT_ENDPOINTS,
      (path) => this.client.get<unknown>(`${path}?${query}`)
    );
    return parseSchemaSnapshot(payload);
  }

  async refreshSnapshot(target: SchemaTargetRef): Promise<SchemaRefreshResponse> {
    const body = buildTargetBody(target);
    const payload = await this.requestWithFallback(
      REFRESH_ENDPOINTS,
      (path) => this.client.post<unknown>(path, body)
    );
    return parseSchemaRefreshResponse(payload);
  }

  formatError(err: unknown): string {
    return normalizeApiError(err);
  }

  private async requestWithFallback<T>(
    endpoints: readonly string[],
    run: (endpoint: string) => Promise<T>
  ): Promise<T> {
    let lastError: unknown;

    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index];
      try {
        return await run(endpoint);
      } catch (err) {
        const isLast = index === endpoints.length - 1;
        if (isLast || !isNotFound(err)) {
          throw err;
        }
        lastError = err;
      }
    }

    throw lastError ?? new Error("Schema API request failed.");
  }
}

function buildTargetQuery(target: SchemaTargetRef): string {
  const params = buildTargetParams(target);
  return params.toString();
}

function buildTargetBody(target: SchemaTargetRef): Record<string, string> {
  const params = buildTargetParams(target);
  const body: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    body[key] = value;
  }
  return body;
}

function buildTargetParams(target: SchemaTargetRef): URLSearchParams {
  const params = new URLSearchParams();
  const targetId = normalizeValue(target.targetId);
  const projectId = normalizeValue(target.projectId);
  const envId = normalizeValue(target.envId);

  if (!targetId && (!projectId || !envId)) {
    throw new Error("Schema target requires `targetId` or both `projectId` and `envId`.");
  }

  if (targetId) {
    params.set("targetId", targetId);
  }
  if (projectId) {
    params.set("projectId", projectId);
  }
  if (envId) {
    params.set("envId", envId);
  }

  return params;
}

function normalizeValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status?: unknown }).status === 404
  );
}
