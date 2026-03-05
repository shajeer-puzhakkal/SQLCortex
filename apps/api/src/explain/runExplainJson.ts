import { redactError } from "../../../../packages/shared/src";

export type ExplainRunnerErrorCode =
  | "INVALID_INPUT"
  | "SQL_NOT_READ_ONLY"
  | "INVALID_EXPLAIN_JSON"
  | "ANALYZER_TIMEOUT"
  | "ANALYZER_ERROR";

export class ExplainRunnerError extends Error {
  public readonly code: ExplainRunnerErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ExplainRunnerErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExplainRunnerError";
    this.code = code;
    this.status = status;
    if (details) {
      this.details = details;
    }
  }
}

export type RunConnectionQueryFn = (
  connectionString: string,
  sql: string,
  timeoutMs?: number,
) => Promise<unknown>;

const DEFAULT_EXPLAIN_TIMEOUT_MS = 2_000;
const ALLOWED_START_KEYWORDS = new Set(["select", "with"]);
const BLOCKED_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
];

function stripSqlCommentsAndLiterals(sql: string): string {
  const withoutLineComments = sql.replace(/--.*?$/gm, " ");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlockComments
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\"\"|[^\"])*"/g, "\"\"");
}

function extractFirstKeyword(sql: string): string | null {
  const match = sql.match(/\b([a-zA-Z]+)\b/);
  return match?.[1]?.toLowerCase() ?? null;
}

function containsBlockedKeyword(sql: string): string | null {
  const pattern = new RegExp(`\\b(${BLOCKED_KEYWORDS.join("|")})\\b`, "i");
  const match = sql.match(pattern);
  return match?.[1] ?? null;
}

function normalizeExplainableSql(sql: string): string {
  const normalized = sql.trim().replace(/;+\s*$/, "");
  if (!normalized) {
    throw new ExplainRunnerError("INVALID_INPUT", "`sql` is required.", 400);
  }
  if (normalized.includes(";")) {
    throw new ExplainRunnerError(
      "INVALID_INPUT",
      "Only a single SQL statement is allowed for EXPLAIN.",
      400,
    );
  }

  const cleaned = stripSqlCommentsAndLiterals(normalized);
  const firstKeyword = extractFirstKeyword(cleaned);
  if (!firstKeyword) {
    throw new ExplainRunnerError("INVALID_INPUT", "Unable to parse SQL input.", 400);
  }
  if (firstKeyword === "explain") {
    throw new ExplainRunnerError(
      "INVALID_INPUT",
      "Provide a SELECT or WITH statement. EXPLAIN is executed server-side.",
      400,
    );
  }
  if (!ALLOWED_START_KEYWORDS.has(firstKeyword)) {
    throw new ExplainRunnerError(
      "SQL_NOT_READ_ONLY",
      "Only SELECT or WITH statements are permitted.",
      400,
    );
  }

  const blockedKeyword = containsBlockedKeyword(cleaned);
  if (blockedKeyword) {
    throw new ExplainRunnerError(
      "SQL_NOT_READ_ONLY",
      "Unsafe statements are blocked for EXPLAIN.",
      400,
      { keyword: blockedKeyword.toUpperCase() },
    );
  }

  const lowered = cleaned.toLowerCase();
  if (
    /\binto\b/.test(lowered) ||
    /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(lowered)
  ) {
    throw new ExplainRunnerError(
      "SQL_NOT_READ_ONLY",
      "SELECT ... INTO and locking clauses are not permitted.",
      400,
    );
  }

  return normalized;
}

function extractExplainJsonFromRows(rows: unknown[]): unknown | null {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const first = rows[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const record = first as Record<string, unknown>;
  const firstKey = Object.keys(record)[0];
  if (!firstKey) {
    return null;
  }
  const payload = record[firstKey];
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload;
}

function isTimeoutError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "P1008" || code === "57014") {
    return true;
  }
  const reason = redactError(err).toLowerCase();
  return reason.includes("timeout") || reason.includes("statement timeout");
}

export async function runExplainJson(params: {
  connectionString: string;
  sql: string;
  runConnectionQuery: RunConnectionQueryFn;
  timeoutMs?: number;
}): Promise<unknown> {
  const normalizedSql = normalizeExplainableSql(params.sql);
  const timeoutMs =
    Number.isFinite(params.timeoutMs) && (params.timeoutMs ?? 0) > 0
      ? Math.round(params.timeoutMs as number)
      : DEFAULT_EXPLAIN_TIMEOUT_MS;
  const explainSql = `EXPLAIN (FORMAT JSON) ${normalizedSql}`;

  let rows: unknown;
  try {
    rows = await params.runConnectionQuery(params.connectionString, explainSql, timeoutMs);
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new ExplainRunnerError("ANALYZER_TIMEOUT", "EXPLAIN timed out.", 504, {
        reason: redactError(err),
      });
    }
    throw new ExplainRunnerError("ANALYZER_ERROR", "Failed to execute EXPLAIN.", 502, {
      reason: redactError(err),
    });
  }

  const explainJson = extractExplainJsonFromRows(Array.isArray(rows) ? rows : []);
  if (!explainJson) {
    throw new ExplainRunnerError(
      "INVALID_EXPLAIN_JSON",
      "EXPLAIN did not return JSON output.",
      400,
    );
  }

  return explainJson;
}
