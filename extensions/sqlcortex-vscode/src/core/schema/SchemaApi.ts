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

type LegacySchemaListResponse = {
  schemas?: Array<{ name?: string | null }>;
};

type LegacySchemaMetadataResponse = {
  schema?: string | null;
  tables?: LegacySchemaTable[];
};

type LegacySchemaTable = {
  name?: string | null;
  type?: string | null;
  columns?: LegacySchemaColumn[];
  foreignKeys?: LegacySchemaForeignKey[];
  indexes?: LegacySchemaIndex[];
};

type LegacySchemaColumn = {
  name?: string | null;
  type?: string | null;
  dataType?: string | null;
  nullable?: boolean | null;
  default?: string | null;
};

type LegacySchemaForeignKey = {
  name?: string | null;
  columns?: string[];
  foreignSchema?: string | null;
  referencedSchema?: string | null;
  foreignTable?: string | null;
  referencedTable?: string | null;
  foreignColumns?: string[];
  referencedColumns?: string[];
  onUpdate?: string | null;
  onDelete?: string | null;
};

type LegacySchemaIndex = {
  name?: string | null;
  columns?: string[];
  unique?: boolean | null;
  primary?: boolean | null;
  method?: string | null;
  predicate?: string | null;
};

export class SchemaApi {
  constructor(private readonly client: ApiClient) {}

  async getSnapshot(target: SchemaTargetRef): Promise<SchemaSnapshot> {
    const query = buildTargetQuery(target);
    try {
      const payload = await this.requestWithFallback(
        SNAPSHOT_ENDPOINTS,
        (path) => this.client.get<unknown>(`${path}?${query}`)
      );
      return parseSchemaSnapshot(payload);
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      const fallback = await this.tryBuildLegacySnapshot(target);
      if (fallback) {
        return fallback;
      }
      throw err;
    }
  }

  async refreshSnapshot(target: SchemaTargetRef): Promise<SchemaRefreshResponse> {
    const body = buildTargetBody(target);
    try {
      const payload = await this.requestWithFallback(
        REFRESH_ENDPOINTS,
        (path) => this.client.post<unknown>(path, body)
      );
      return parseSchemaRefreshResponse(payload);
    } catch (err) {
      if (!isRefreshEndpointUnavailable(err)) {
        throw err;
      }
      const snapshot = await this.getSnapshot(target);
      return {
        ok: true,
        status: "fetched",
        refreshedAt: snapshot.capturedAt ?? null,
        snapshot,
      };
    }
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

  private async tryBuildLegacySnapshot(
    target: SchemaTargetRef
  ): Promise<SchemaSnapshot | null> {
    const projectId = normalizeValue(target.projectId);
    const envId = normalizeValue(target.envId);
    if (!projectId || !envId) {
      return null;
    }

    const basePath = `/api/v1/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(
      envId
    )}/schema`;

    const schemasPayload = await this.client.get<LegacySchemaListResponse>(
      `${basePath}/schemas`
    );
    const schemaNames = (schemasPayload.schemas ?? [])
      .map((entry) => normalizeValue(entry.name))
      .filter((entry): entry is string => Boolean(entry));

    const metadata = await Promise.all(
      schemaNames.map((schemaName) =>
        this.client.get<LegacySchemaMetadataResponse>(
          `${basePath}/metadata?schema=${encodeURIComponent(schemaName)}`
        )
      )
    );

    const schemas = metadata.map((record, index) =>
      mapLegacySchema(record, schemaNames[index] ?? "")
    );

    return {
      projectId,
      envId,
      targetId: normalizeValue(target.targetId) ?? undefined,
      schemas,
    };
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

function isRefreshEndpointUnavailable(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : null;
  return status === 404 || status === 405;
}

function mapLegacySchema(
  payload: LegacySchemaMetadataResponse,
  fallbackName: string
): SchemaSnapshot["schemas"][number] {
  const schemaName = normalizeValue(payload.schema) ?? fallbackName;
  const tables: SchemaSnapshot["schemas"][number]["tables"] = [];
  const views: SchemaSnapshot["schemas"][number]["views"] = [];

  for (const entry of payload.tables ?? []) {
    const name = normalizeValue(entry.name);
    if (!name) {
      continue;
    }

    const type = normalizeValue(entry.type)?.toLowerCase();
    const isView = type === "view";

    if (isView) {
      views.push({ name, definition: null });
      continue;
    }

    tables.push({
      name,
      columns: (entry.columns ?? [])
        .map(mapLegacyColumn)
        .filter((column): column is NonNullable<typeof column> => Boolean(column)),
      constraints: [],
      foreignKeys: (entry.foreignKeys ?? [])
        .map(mapLegacyForeignKey)
        .filter((fk): fk is NonNullable<typeof fk> => Boolean(fk)),
      indexes: (entry.indexes ?? [])
        .map(mapLegacyIndex)
        .filter((index): index is NonNullable<typeof index> => Boolean(index)),
    });
  }

  return {
    name: schemaName,
    tables,
    views,
    routines: [],
    functions: [],
    procedures: [],
  };
}

function mapLegacyColumn(
  column: LegacySchemaColumn
): SchemaSnapshot["schemas"][number]["tables"][number]["columns"][number] | null {
  const name = normalizeValue(column.name);
  const dataType = normalizeValue(column.dataType ?? column.type);
  if (!name || !dataType) {
    return null;
  }
  return {
    name,
    dataType,
    nullable: Boolean(column.nullable),
    default: typeof column.default === "string" ? column.default : null,
  };
}

function mapLegacyForeignKey(
  fk: LegacySchemaForeignKey
): SchemaSnapshot["schemas"][number]["tables"][number]["foreignKeys"][number] | null {
  const name = normalizeValue(fk.name);
  const referencedSchema = normalizeValue(fk.referencedSchema ?? fk.foreignSchema);
  const referencedTable = normalizeValue(fk.referencedTable ?? fk.foreignTable);
  if (!name || !referencedSchema || !referencedTable) {
    return null;
  }

  return {
    name,
    columns: (fk.columns ?? []).filter((entry): entry is string => typeof entry === "string"),
    referencedSchema,
    referencedTable,
    referencedColumns: (fk.referencedColumns ?? fk.foreignColumns ?? []).filter(
      (entry): entry is string => typeof entry === "string"
    ),
    onUpdate: typeof fk.onUpdate === "string" ? fk.onUpdate : null,
    onDelete: typeof fk.onDelete === "string" ? fk.onDelete : null,
  };
}

function mapLegacyIndex(
  index: LegacySchemaIndex
): SchemaSnapshot["schemas"][number]["tables"][number]["indexes"][number] | null {
  const name = normalizeValue(index.name);
  if (!name) {
    return null;
  }

  return {
    name,
    columns: (index.columns ?? []).filter((entry): entry is string => typeof entry === "string"),
    unique: Boolean(index.unique),
    primary: Boolean(index.primary),
    method: normalizeValue(index.method),
    predicate: normalizeValue(index.predicate),
  };
}
