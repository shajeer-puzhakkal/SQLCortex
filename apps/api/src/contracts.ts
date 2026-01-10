import { Analysis } from "@prisma/client";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_EXPLAIN_JSON"
  | "SQL_NOT_READ_ONLY"
  | "RATE_LIMITED"
  | "PLAN_LIMIT_EXCEEDED"
  | "ANALYZER_TIMEOUT"
  | "ANALYZER_ERROR"
  | "SCHEMA_FETCH_FAILED";

export type ErrorResponse = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type HealthResponse = { ok: true; service: string };

export type AnalysisCreateRequest = {
  sql: string;
  explain_json: unknown;
  project_id?: string | null;
};

export type AnalysisResource = {
  id: string;
  status: string;
  sql: string;
  explain_json: unknown;
  result: unknown | null;
  project_id: string | null;
  user_id: string | null;
  org_id: string | null;
  created_at: string;
  updated_at: string;
};

export type AnalysisCreateResponse = { analysis: AnalysisResource };
export type AnalysisGetResponse = { analysis: AnalysisResource };
export type AnalysisListResponse = { analyses: AnalysisResource[] };

export type AiSqlRequest = {
  sql: string;
  project_id: string;
  connection_id: string;
  user_intent?: string | null;
};

export type AiSqlResponse = {
  summary: string;
  findings: string[];
  recommendations: string[];
  risk_level: "low" | "medium" | "high";
  meta: { provider: string; model: string; latency_ms: number };
};

export const ERROR_CODES: ErrorCode[] = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_EXPLAIN_JSON",
  "SQL_NOT_READ_ONLY",
  "RATE_LIMITED",
  "PLAN_LIMIT_EXCEEDED",
  "ANALYZER_TIMEOUT",
  "ANALYZER_ERROR",
  "SCHEMA_FETCH_FAILED",
];

export function mapAnalysisToResource(record: Analysis): AnalysisResource {
  return {
    id: record.id,
    status: record.status,
    sql: record.sql,
    explain_json: record.explainJson,
    result: record.result,
    project_id: record.projectId ?? null,
    user_id: record.userId ?? null,
    org_id: record.orgId ?? null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): ErrorResponse {
  return { code, message, ...(details ? { details } : {}) };
}
