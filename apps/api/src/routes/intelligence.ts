import type { PrismaClient } from "@prisma/client";
import type { Express, Request, Response } from "express";
import { createHash } from "node:crypto";
import {
  extractQueryFeatures,
  type IntelligenceResult,
  normalizeCost,
  parsePlan,
  type PlanSummary,
  evaluateQueryFeatures,
} from "../../../../packages/intelligence/src";
import { hashSql, normalizeSql as normalizeSqlForHash } from "../../../../packages/shared/src/sql";
import type {
  IntelligenceHistoryResponse,
  IntelligenceMode,
  ObservabilityCollectRequest,
  ObservabilityCollectResponse,
  ObservabilitySnapshotMetric,
  SchemaSnapshotCaptureRequest,
  SchemaSnapshotCaptureResponse,
  IntelligenceScoreRequest,
  IntelligenceScoreResponse,
  IntelligenceTopRiskyResponse,
  IntelligenceTrendsResponse,
} from "../contracts";
import { makeError, type ErrorResponse } from "../contracts";
import { requireAuth, type AuthenticatedRequest } from "../auth";
import { ExplainRunnerError, runExplainJson, type RunConnectionQueryFn } from "../explain/runExplainJson";

type ResolvedProjectConnection =
  | { error: ErrorResponse; status: number }
  | {
      projectId: string;
      orgId: string | null;
      connection: {
        id: string;
      };
      connectionString: string;
    };

type ResolveProjectConnectionFn = (
  auth: NonNullable<AuthenticatedRequest["auth"]>,
  projectId: string,
  connectionId: string,
) => Promise<ResolvedProjectConnection>;

type ProjectScope =
  | { error: ErrorResponse; status: number }
  | { projectId: string; orgId: string | null };

type ThrottleBucket = { windowStartMs: number; count: number; lastSeenMs: number };
type PlanCacheEntry = { expiresAt: number; payload: IntelligenceScoreResponse };
type EndpointCacheEntry = { expiresAt: number; payload: unknown };
type CircuitState = { timeoutCount: number; lastTimeoutMs: number; openUntilMs: number; lastSeenMs: number };
type ObservabilityCollectedMetric = ObservabilitySnapshotMetric & { metric_data: Record<string, unknown> };
type SchemaSnapshotRowCounts = {
  tables: number;
  columns: number;
  indexes: number;
  constraints: number;
  foreign_keys: number;
};
type SchemaSnapshotJson = {
  tables: Array<{ schema_name: string; table_name: string }>;
  columns: Array<{
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    ordinal_position: number;
  }>;
  indexes: Array<{
    schema_name: string;
    table_name: string;
    index_name: string;
    is_unique: boolean;
    index_definition: string;
  }>;
  constraints: Array<{
    schema_name: string;
    table_name: string;
    constraint_name: string;
    constraint_type: string;
  }>;
  foreign_keys: Array<{
    schema_name: string;
    table_name: string;
    constraint_name: string;
    column_name: string;
    foreign_schema_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    ordinal_position: number;
  }>;
};
type SchemaChangeType =
  | "table_added"
  | "table_dropped"
  | "column_added"
  | "column_removed"
  | "index_created"
  | "index_dropped";
type SchemaChangeRecord = {
  change_type: SchemaChangeType;
  object_name: string;
};

const HISTORY_LIMIT_DEFAULT = 25;
const HISTORY_LIMIT_MAX = 100;
const TOP_RISKY_LIMIT_DEFAULT = 10;
const TOP_RISKY_LIMIT_MAX = 25;
const OBSERVABILITY_TABLE_STATS_LIMIT = Math.max(
  50,
  Number(process.env.OBSERVABILITY_TABLE_STATS_LIMIT ?? 500) || 500,
);
const OBSERVABILITY_INDEX_STATS_LIMIT = Math.max(
  50,
  Number(process.env.OBSERVABILITY_INDEX_STATS_LIMIT ?? 1000) || 1000,
);
const OBSERVABILITY_QUERY_STATS_LIMIT = Math.max(
  10,
  Number(process.env.OBSERVABILITY_QUERY_STATS_LIMIT ?? 100) || 100,
);
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_BUCKET_TTL_MS = 10 * 60_000;
const THROTTLE_LIMIT_PER_MIN = Math.max(
  20,
  Number(process.env.INTELLIGENCE_RATE_LIMIT_PER_MIN ?? 120) || 120,
);
const PLAN_THROTTLE_LIMIT_PER_MIN = Math.max(
  5,
  Number(process.env.INTELLIGENCE_PLAN_RATE_LIMIT_PER_MIN ?? 40) || 40,
);
const PLAN_CACHE_TTL_MS = Math.max(
  15_000,
  (Number(process.env.INTELLIGENCE_PLAN_CACHE_TTL_SECONDS ?? 45) || 45) * 1000,
);
const ENDPOINT_CACHE_TTL_MS = Math.max(
  5_000,
  (Number(process.env.INTELLIGENCE_ENDPOINT_CACHE_TTL_SECONDS ?? 15) || 15) * 1000,
);
const CIRCUIT_TIMEOUT_THRESHOLD = Math.max(
  2,
  Number(process.env.INTELLIGENCE_EXPLAIN_CIRCUIT_THRESHOLD ?? 3) || 3,
);
const CIRCUIT_TIMEOUT_WINDOW_MS = Math.max(
  60_000,
  (Number(process.env.INTELLIGENCE_EXPLAIN_CIRCUIT_WINDOW_SECONDS ?? 300) || 300) * 1000,
);
const CIRCUIT_COOLDOWN_MS = Math.max(
  30_000,
  (Number(process.env.INTELLIGENCE_EXPLAIN_CIRCUIT_COOLDOWN_SECONDS ?? 120) || 120) * 1000,
);
const STORE_QUERY_TEXT = isTruthy(process.env.INTELLIGENCE_STORE_QUERY_TEXT);

const throttleBuckets = new Map<string, ThrottleBucket>();
const planScoreCache = new Map<string, PlanCacheEntry>();
const endpointCache = new Map<string, EndpointCacheEntry>();
const explainCircuit = new Map<string, CircuitState>();

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreLabel(score: number): IntelligenceScoreResponse["performance_label"] {
  if (score >= 90) {
    return "Excellent";
  }
  if (score >= 70) {
    return "Good";
  }
  if (score >= 50) {
    return "Needs Optimization";
  }
  return "Risky";
}

function isIntelligenceMode(value: unknown): value is IntelligenceMode {
  return value === "fast" || value === "plan";
}

function applyPlanSignals(
  baseline: IntelligenceResult,
  planSummary: PlanSummary,
): IntelligenceScoreResponse {
  const reasons = [...baseline.reasons];
  let delta = 0;

  if (planSummary.has_seq_scan) {
    delta -= 8;
    reasons.push({
      code: "PLAN_SEQ_SCAN",
      severity: "warn",
      delta: -8,
      message: "Plan includes sequential scans; verify predicate selectivity and indexes.",
    });
  }

  if (planSummary.has_nested_loop && (planSummary.plan_rows ?? 0) > 1000) {
    delta -= 5;
    reasons.push({
      code: "PLAN_NESTED_LOOP",
      severity: "warn",
      delta: -5,
      message: "Nested loop on larger row estimates may be expensive.",
    });
  }

  if (planSummary.has_sort && (planSummary.plan_rows ?? 0) > 10_000) {
    delta -= 4;
    reasons.push({
      code: "PLAN_SORT_LARGE_ROWS",
      severity: "warn",
      delta: -4,
      message: "Sort over large estimated row counts may increase latency.",
    });
  }

  const costBucket = normalizeCost(planSummary.total_cost);
  if (costBucket === "High") {
    delta -= 6;
    reasons.push({
      code: "PLAN_COST_HIGH",
      severity: "warn",
      delta: -6,
      message: "Estimated plan cost is high for this query.",
    });
  } else if (costBucket === "Extreme") {
    delta -= 12;
    reasons.push({
      code: "PLAN_COST_EXTREME",
      severity: "high",
      delta: -12,
      message: "Estimated plan cost is extreme; optimize before production use.",
    });
  } else if (costBucket === "Low") {
    delta += 2;
    reasons.push({
      code: "PLAN_COST_LOW",
      severity: "info",
      delta: 2,
      message: "Estimated plan cost is low.",
    });
  }

  const performanceScore = clampScore(baseline.performance_score + delta);
  return {
    ...baseline,
    performance_score: performanceScore,
    performance_label: scoreLabel(performanceScore),
    cost_bucket: costBucket,
    reasons,
    plan_summary: planSummary,
  };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function parsePage(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.floor(value);
}

function normalizeRange(range: unknown): "7d" | "30d" {
  return range === "30d" ? "30d" : "7d";
}

function resolveRangeStart(range: "7d" | "30d"): { start: Date; endExclusive: Date } {
  const days = range === "30d" ? 30 : 7;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(dayStart);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const endExclusive = new Date(dayStart);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start, endExclusive };
}

function resolvePrincipalKey(auth: NonNullable<AuthenticatedRequest["auth"]>): string {
  if (auth.userId) {
    return `user:${auth.userId}`;
  }
  if (auth.orgId) {
    return `org:${auth.orgId}`;
  }
  if (auth.tokenId) {
    return `token:${auth.tokenId}`;
  }
  return "session:unknown";
}

function cleanupThrottleBuckets(nowMs: number): void {
  if (throttleBuckets.size <= 20_000) {
    return;
  }
  for (const [key, bucket] of throttleBuckets.entries()) {
    if (nowMs - bucket.lastSeenMs > THROTTLE_BUCKET_TTL_MS) {
      throttleBuckets.delete(key);
    }
  }
}

function checkThrottle(params: {
  auth: NonNullable<AuthenticatedRequest["auth"]>;
  projectId: string;
  mode: "read" | "fast" | "plan";
}): { limited: boolean; retryAfterSeconds?: number } {
  const principal = resolvePrincipalKey(params.auth);
  const key = `${principal}:${params.projectId}:${params.mode}`;
  const nowMs = Date.now();
  cleanupThrottleBuckets(nowMs);

  const limit = params.mode === "plan" ? PLAN_THROTTLE_LIMIT_PER_MIN : THROTTLE_LIMIT_PER_MIN;
  const existing = throttleBuckets.get(key);
  if (!existing || nowMs - existing.windowStartMs >= THROTTLE_WINDOW_MS) {
    throttleBuckets.set(key, { windowStartMs: nowMs, count: 1, lastSeenMs: nowMs });
    return { limited: false };
  }

  existing.lastSeenMs = nowMs;
  if (existing.count + 1 > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.windowStartMs + THROTTLE_WINDOW_MS - nowMs) / 1000),
    );
    return { limited: true, retryAfterSeconds };
  }

  existing.count += 1;
  return { limited: false };
}

function endpointCacheKey(projectId: string, endpoint: string, parts: string[]): string {
  return `${projectId}:${endpoint}:${parts.join(":")}`;
}

function readEndpointCache<T>(key: string): T | null {
  const entry = endpointCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    endpointCache.delete(key);
    return null;
  }
  return entry.payload as T;
}

function writeEndpointCache<T>(key: string, payload: T): void {
  endpointCache.set(key, { expiresAt: Date.now() + ENDPOINT_CACHE_TTL_MS, payload });
}

function invalidateEndpointCache(projectId: string): void {
  for (const key of endpointCache.keys()) {
    if (key.startsWith(`${projectId}:`)) {
      endpointCache.delete(key);
    }
  }
}

function readPlanCache(key: string): IntelligenceScoreResponse | null {
  const entry = planScoreCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    planScoreCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writePlanCache(key: string, payload: IntelligenceScoreResponse): void {
  planScoreCache.set(key, { expiresAt: Date.now() + PLAN_CACHE_TTL_MS, payload });
}

function checkExplainCircuit(connectionId: string): { blocked: boolean; retryAfterSeconds?: number } {
  const nowMs = Date.now();
  const state = explainCircuit.get(connectionId);
  if (!state || state.openUntilMs <= nowMs) {
    return { blocked: false };
  }
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((state.openUntilMs - nowMs) / 1000)) };
}

function recordExplainTimeout(connectionId: string): { opened: boolean; retryAfterSeconds?: number } {
  const nowMs = Date.now();
  const existing = explainCircuit.get(connectionId);
  if (!existing || nowMs - existing.lastTimeoutMs > CIRCUIT_TIMEOUT_WINDOW_MS) {
    explainCircuit.set(connectionId, { timeoutCount: 1, lastTimeoutMs: nowMs, openUntilMs: 0, lastSeenMs: nowMs });
    return { opened: false };
  }
  const timeoutCount = existing.timeoutCount + 1;
  const openUntilMs = timeoutCount >= CIRCUIT_TIMEOUT_THRESHOLD ? nowMs + CIRCUIT_COOLDOWN_MS : 0;
  explainCircuit.set(connectionId, { timeoutCount, lastTimeoutMs: nowMs, openUntilMs, lastSeenMs: nowMs });
  if (openUntilMs <= nowMs) {
    return { opened: false };
  }
  return { opened: true, retryAfterSeconds: Math.max(1, Math.ceil((openUntilMs - nowMs) / 1000)) };
}

function clearExplainCircuit(connectionId: string): void {
  explainCircuit.delete(connectionId);
}

async function resolveProjectScope(
  prisma: PrismaClient,
  auth: NonNullable<AuthenticatedRequest["auth"]>,
  projectId: string,
): Promise<ProjectScope> {
  if (auth.tokenProjectId && auth.tokenProjectId !== projectId) {
    return { error: makeError("FORBIDDEN", "Token is restricted to a different project"), status: 403 };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerUserId: true, orgId: true },
  });
  if (!project) {
    return { error: makeError("INVALID_INPUT", "Project not found"), status: 400 };
  }

  if (project.ownerUserId) {
    if (auth.userId !== project.ownerUserId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: null };
  }
  if (!project.orgId) {
    return { error: makeError("INVALID_INPUT", "Project ownership is invalid"), status: 400 };
  }
  if (auth.orgId === project.orgId) {
    return { projectId: project.id, orgId: project.orgId };
  }
  if (!auth.userId) {
    return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
  }

  const membership = await prisma.orgMember.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId: project.orgId } },
    select: { id: true },
  });
  if (!membership) {
    return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
  }
  return { projectId: project.id, orgId: project.orgId };
}

function redactSqlLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\$\d+/g, "?");
}

function toNumeric(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "t" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function sortObjectKeysForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeysForHash(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeysForHash(obj[key]);
  }
  return sorted;
}

function toObjectRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

function mapSchemaSnapshotTables(rows: unknown): SchemaSnapshotJson["tables"] {
  return toObjectRows(rows).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
  }));
}

function mapSchemaSnapshotColumns(rows: unknown): SchemaSnapshotJson["columns"] {
  return toObjectRows(rows).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
    column_name: toText(row.column_name) ?? "unknown",
    data_type: toText(row.data_type) ?? "unknown",
    is_nullable: (toText(row.is_nullable) ?? "").toUpperCase() === "YES",
    column_default: toText(row.column_default),
    ordinal_position: toNumeric(row.ordinal_position),
  }));
}

function mapSchemaSnapshotIndexes(rows: unknown): SchemaSnapshotJson["indexes"] {
  return toObjectRows(rows).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
    index_name: toText(row.index_name) ?? "unknown",
    is_unique: toBoolean(row.is_unique),
    index_definition: toText(row.index_definition) ?? "",
  }));
}

function mapSchemaSnapshotConstraints(rows: unknown): SchemaSnapshotJson["constraints"] {
  return toObjectRows(rows).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
    constraint_name: toText(row.constraint_name) ?? "unknown",
    constraint_type: toText(row.constraint_type) ?? "UNKNOWN",
  }));
}

function mapSchemaSnapshotForeignKeys(rows: unknown): SchemaSnapshotJson["foreign_keys"] {
  return toObjectRows(rows).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
    constraint_name: toText(row.constraint_name) ?? "unknown",
    column_name: toText(row.column_name) ?? "unknown",
    foreign_schema_name: toText(row.foreign_schema_name) ?? "public",
    foreign_table_name: toText(row.foreign_table_name) ?? "unknown",
    foreign_column_name: toText(row.foreign_column_name) ?? "unknown",
    ordinal_position: toNumeric(row.ordinal_position),
  }));
}

function normalizeStoredSchemaSnapshot(value: unknown): SchemaSnapshotJson | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const snapshot = parsed as Record<string, unknown>;
  return {
    tables: mapSchemaSnapshotTables(snapshot.tables),
    columns: mapSchemaSnapshotColumns(snapshot.columns),
    indexes: mapSchemaSnapshotIndexes(snapshot.indexes),
    constraints: mapSchemaSnapshotConstraints(snapshot.constraints),
    foreign_keys: mapSchemaSnapshotForeignKeys(snapshot.foreign_keys),
  };
}

function toTableObjectName(entry: SchemaSnapshotJson["tables"][number]): string {
  return `${entry.schema_name}.${entry.table_name}`;
}

function toColumnObjectName(entry: SchemaSnapshotJson["columns"][number]): string {
  return `${entry.schema_name}.${entry.table_name}.${entry.column_name}`;
}

function toIndexObjectName(entry: SchemaSnapshotJson["indexes"][number]): string {
  return `${entry.schema_name}.${entry.table_name}.${entry.index_name}`;
}

function detectSchemaChanges(params: {
  previous: SchemaSnapshotJson;
  current: SchemaSnapshotJson;
}): SchemaChangeRecord[] {
  const changes: SchemaChangeRecord[] = [];

  const previousTables = new Set(params.previous.tables.map((entry) => toTableObjectName(entry)));
  const currentTables = new Set(params.current.tables.map((entry) => toTableObjectName(entry)));
  for (const objectName of currentTables) {
    if (!previousTables.has(objectName)) {
      changes.push({ change_type: "table_added", object_name: objectName });
    }
  }
  for (const objectName of previousTables) {
    if (!currentTables.has(objectName)) {
      changes.push({ change_type: "table_dropped", object_name: objectName });
    }
  }

  const previousColumns = new Set(params.previous.columns.map((entry) => toColumnObjectName(entry)));
  const currentColumns = new Set(params.current.columns.map((entry) => toColumnObjectName(entry)));
  for (const objectName of currentColumns) {
    if (!previousColumns.has(objectName)) {
      changes.push({ change_type: "column_added", object_name: objectName });
    }
  }
  for (const objectName of previousColumns) {
    if (!currentColumns.has(objectName)) {
      changes.push({ change_type: "column_removed", object_name: objectName });
    }
  }

  const previousIndexes = new Set(params.previous.indexes.map((entry) => toIndexObjectName(entry)));
  const currentIndexes = new Set(params.current.indexes.map((entry) => toIndexObjectName(entry)));
  for (const objectName of currentIndexes) {
    if (!previousIndexes.has(objectName)) {
      changes.push({ change_type: "index_created", object_name: objectName });
    }
  }
  for (const objectName of previousIndexes) {
    if (!currentIndexes.has(objectName)) {
      changes.push({ change_type: "index_dropped", object_name: objectName });
    }
  }

  return changes;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeIndexUsagePercent(idxScan: number, seqScan: number): number {
  const total = idxScan + seqScan;
  if (total <= 0) {
    return 0;
  }
  return roundTo((idxScan / total) * 100, 2);
}

function isPgStatStatementsUnavailable(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("pg_stat_statements") &&
    (message.includes("does not exist") ||
      message.includes("permission denied") ||
      message.includes("must be loaded"))
  );
}

function buildObservabilityQueries(): {
  tableStats: string;
  indexStats: string;
  queryStats: string;
} {
  return {
    tableStats: `
      SELECT
        schemaname AS schema_name,
        relname AS table_name,
        seq_scan::bigint AS seq_scan,
        idx_scan::bigint AS idx_scan,
        n_tup_ins::bigint AS rows_inserted,
        n_tup_upd::bigint AS rows_updated,
        n_tup_del::bigint AS rows_deleted
      FROM pg_stat_user_tables
      ORDER BY (seq_scan + idx_scan) DESC, relname ASC
      LIMIT ${OBSERVABILITY_TABLE_STATS_LIMIT}
    `,
    indexStats: `
      SELECT
        s.schemaname AS schema_name,
        s.relname AS table_name,
        s.indexrelname AS index_name,
        s.idx_scan::bigint AS idx_scan,
        s.idx_tup_read::bigint AS idx_tup_read,
        s.idx_tup_fetch::bigint AS idx_tup_fetch
      FROM pg_stat_user_indexes s
      ORDER BY s.idx_scan DESC, s.indexrelname ASC
      LIMIT ${OBSERVABILITY_INDEX_STATS_LIMIT}
    `,
    queryStats: `
      SELECT
        queryid::text AS query_id,
        calls::bigint AS calls,
        total_exec_time::double precision AS total_exec_time_ms,
        mean_exec_time::double precision AS mean_exec_time_ms,
        rows::bigint AS rows
      FROM pg_stat_statements
      ORDER BY total_exec_time DESC
      LIMIT ${OBSERVABILITY_QUERY_STATS_LIMIT}
    `,
  };
}

function buildSchemaSnapshotQueries(): {
  tables: string;
  columns: string;
  indexes: string;
  constraints: string;
  foreignKeys: string;
} {
  return {
    tables: `
      SELECT
        table_schema AS schema_name,
        table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY table_schema ASC, table_name ASC
    `,
    columns: `
      SELECT
        table_schema AS schema_name,
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default,
        ordinal_position::int AS ordinal_position
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY table_schema ASC, table_name ASC, ordinal_position ASC
    `,
    indexes: `
      SELECT
        n.nspname AS schema_name,
        t.relname AS table_name,
        i.relname AS index_name,
        idx.indisunique AS is_unique,
        pg_get_indexdef(idx.indexrelid) AS index_definition
      FROM pg_index idx
      JOIN pg_class i ON i.oid = idx.indexrelid
      JOIN pg_class t ON t.oid = idx.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY n.nspname ASC, t.relname ASC, i.relname ASC
    `,
    constraints: `
      SELECT
        tc.table_schema AS schema_name,
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY tc.table_schema ASC, tc.table_name ASC, tc.constraint_name ASC
    `,
    foreignKeys: `
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        con.conname AS constraint_name,
        a.attname AS column_name,
        fn.nspname AS foreign_schema_name,
        fc.relname AS foreign_table_name,
        fa.attname AS foreign_column_name,
        mapping.ordinal_position::int AS ordinal_position
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class fc ON fc.oid = con.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
        AS mapping(column_attnum, foreign_attnum, ordinal_position) ON true
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = mapping.column_attnum
      JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = mapping.foreign_attnum
      WHERE con.contype = 'f'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY
        n.nspname ASC,
        c.relname ASC,
        con.conname ASC,
        mapping.ordinal_position ASC
    `,
  };
}

async function collectSchemaSnapshot(params: {
  runConnectionQuery: RunConnectionQueryFn;
  connectionString: string;
}): Promise<{
  schema_hash: string;
  schema_json: SchemaSnapshotJson;
  object_counts: SchemaSnapshotRowCounts;
}> {
  const queries = buildSchemaSnapshotQueries();
  const tableRowsRaw = await params.runConnectionQuery(params.connectionString, queries.tables);
  const columnRowsRaw = await params.runConnectionQuery(params.connectionString, queries.columns);
  const indexRowsRaw = await params.runConnectionQuery(params.connectionString, queries.indexes);
  const constraintRowsRaw = await params.runConnectionQuery(params.connectionString, queries.constraints);
  const foreignKeyRowsRaw = await params.runConnectionQuery(params.connectionString, queries.foreignKeys);

  const schemaJson: SchemaSnapshotJson = {
    tables: mapSchemaSnapshotTables(tableRowsRaw),
    columns: mapSchemaSnapshotColumns(columnRowsRaw),
    indexes: mapSchemaSnapshotIndexes(indexRowsRaw),
    constraints: mapSchemaSnapshotConstraints(constraintRowsRaw),
    foreign_keys: mapSchemaSnapshotForeignKeys(foreignKeyRowsRaw),
  };

  const schemaHash = createHash("sha256")
    .update(JSON.stringify(sortObjectKeysForHash(schemaJson)))
    .digest("hex");
  const objectCounts: SchemaSnapshotRowCounts = {
    tables: schemaJson.tables.length,
    columns: schemaJson.columns.length,
    indexes: schemaJson.indexes.length,
    constraints: schemaJson.constraints.length,
    foreign_keys: schemaJson.foreign_keys.length,
  };

  return {
    schema_hash: schemaHash,
    schema_json: schemaJson,
    object_counts: objectCounts,
  };
}

async function collectObservabilityMetrics(params: {
  runConnectionQuery: RunConnectionQueryFn;
  connectionString: string;
  snapshotTime: Date;
}): Promise<ObservabilityCollectedMetric[]> {
  const queries = buildObservabilityQueries();
  const tableRowsRaw = await params.runConnectionQuery<unknown[]>(params.connectionString, queries.tableStats);
  const indexRowsRaw = await params.runConnectionQuery<unknown[]>(params.connectionString, queries.indexStats);
  const tableRows = toObjectRows(tableRowsRaw).map((row) => {
    const seqScan = toNumeric(row.seq_scan);
    const idxScan = toNumeric(row.idx_scan);
    const rowsInserted = toNumeric(row.rows_inserted);
    const rowsUpdated = toNumeric(row.rows_updated);
    const rowsDeleted = toNumeric(row.rows_deleted);
    return {
      schema_name: toText(row.schema_name) ?? "public",
      table_name: toText(row.table_name) ?? "unknown",
      seq_scan: seqScan,
      idx_scan: idxScan,
      rows_inserted: rowsInserted,
      rows_updated: rowsUpdated,
      rows_deleted: rowsDeleted,
      index_usage_pct: computeIndexUsagePercent(idxScan, seqScan),
    };
  });
  const tableTotals = tableRows.reduce(
    (acc, row) => {
      acc.seq_scan += row.seq_scan;
      acc.idx_scan += row.idx_scan;
      acc.rows_inserted += row.rows_inserted;
      acc.rows_updated += row.rows_updated;
      acc.rows_deleted += row.rows_deleted;
      return acc;
    },
    {
      seq_scan: 0,
      idx_scan: 0,
      rows_inserted: 0,
      rows_updated: 0,
      rows_deleted: 0,
    },
  );

  const indexRows = toObjectRows(indexRowsRaw).map((row) => ({
    schema_name: toText(row.schema_name) ?? "public",
    table_name: toText(row.table_name) ?? "unknown",
    index_name: toText(row.index_name) ?? "unknown",
    idx_scan: toNumeric(row.idx_scan),
    idx_tup_read: toNumeric(row.idx_tup_read),
    idx_tup_fetch: toNumeric(row.idx_tup_fetch),
  }));

  let queryRows: Array<{
    query_id: string | null;
    calls: number;
    total_exec_time_ms: number;
    mean_exec_time_ms: number;
    rows: number;
  }> = [];
  let queryStatsUnavailable = false;
  try {
    const queryRowsRaw = await params.runConnectionQuery<unknown[]>(params.connectionString, queries.queryStats);
    queryRows = toObjectRows(queryRowsRaw).map((row) => ({
      query_id: toText(row.query_id),
      calls: toNumeric(row.calls),
      total_exec_time_ms: toNumeric(row.total_exec_time_ms),
      mean_exec_time_ms: toNumeric(row.mean_exec_time_ms),
      rows: toNumeric(row.rows),
    }));
  } catch (err) {
    if (!isPgStatStatementsUnavailable(err)) {
      throw err;
    }
    queryStatsUnavailable = true;
  }

  const collectedAt = params.snapshotTime.toISOString();
  const metrics: ObservabilityCollectedMetric[] = [
    {
      metric_type: "table_stats",
      source: "pg_stat_user_tables",
      rows_collected: tableRows.length,
      metric_data: {
        source: "pg_stat_user_tables",
        collected_at: collectedAt,
        totals: {
          ...tableTotals,
          index_usage_pct: computeIndexUsagePercent(tableTotals.idx_scan, tableTotals.seq_scan),
        },
        tables: tableRows,
      },
    },
    {
      metric_type: "index_stats",
      source: "pg_stat_user_indexes",
      rows_collected: indexRows.length,
      metric_data: {
        source: "pg_stat_user_indexes",
        collected_at: collectedAt,
        indexes: indexRows,
      },
    },
    {
      metric_type: "query_stats",
      source: "pg_stat_statements",
      rows_collected: queryRows.length,
      ...(queryStatsUnavailable ? { unavailable: true } : {}),
      metric_data: {
        source: "pg_stat_statements",
        collected_at: collectedAt,
        unavailable: queryStatsUnavailable,
        statements: queryRows,
      },
    },
  ];

  return metrics;
}

async function persistObservabilitySnapshots(params: {
  prisma: PrismaClient;
  projectId: string;
  snapshotTime: Date;
  metrics: ObservabilityCollectedMetric[];
}): Promise<number> {
  let inserted = 0;
  for (const metric of params.metrics) {
    await params.prisma.$executeRawUnsafe(
      `INSERT INTO "observability_snapshots" (
        "project_id",
        "snapshot_time",
        "metric_type",
        "metric_data"
      ) VALUES ($1, $2, $3, $4::jsonb)`,
      params.projectId,
      params.snapshotTime,
      metric.metric_type,
      JSON.stringify(metric.metric_data),
    );
    inserted += 1;
  }
  return inserted;
}

async function persistSchemaSnapshot(params: {
  prisma: PrismaClient;
  projectId: string;
  snapshotTime: Date;
  schemaHash: string;
  schemaJson: SchemaSnapshotJson;
}): Promise<number> {
  return params.prisma.$executeRawUnsafe(
    `INSERT INTO "schema_snapshots" (
      "project_id",
      "snapshot_time",
      "schema_hash",
      "schema_json"
    ) VALUES ($1, $2, $3, $4::jsonb)`,
    params.projectId,
    params.snapshotTime,
    params.schemaHash,
    JSON.stringify(params.schemaJson),
  );
}

async function fetchLatestSchemaSnapshot(params: {
  prisma: PrismaClient;
  projectId: string;
}): Promise<{ schema_hash: string; schema_json: SchemaSnapshotJson } | null> {
  const rows = await params.prisma.$queryRawUnsafe<Array<{ schema_hash: unknown; schema_json: unknown }>>(
    `SELECT "schema_hash", "schema_json"
     FROM "schema_snapshots"
     WHERE "project_id" = $1
     ORDER BY "snapshot_time" DESC, "id" DESC
     LIMIT 1`,
    params.projectId,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  const schemaHash = toText(row.schema_hash);
  if (!schemaHash) {
    return null;
  }
  const schemaJson = normalizeStoredSchemaSnapshot(row.schema_json);
  if (!schemaJson) {
    return null;
  }
  return { schema_hash: schemaHash, schema_json: schemaJson };
}

async function persistSchemaChanges(params: {
  prisma: PrismaClient;
  projectId: string;
  detectedAt: Date;
  changes: SchemaChangeRecord[];
}): Promise<number> {
  let inserted = 0;
  for (const change of params.changes) {
    await params.prisma.$executeRawUnsafe(
      `INSERT INTO "schema_changes" (
        "project_id",
        "change_type",
        "object_name",
        "detected_at"
      ) VALUES ($1, $2, $3, $4)`,
      params.projectId,
      change.change_type,
      change.object_name,
      params.detectedAt,
    );
    inserted += 1;
  }
  return inserted;
}

async function persistIntelligenceEvent(params: {
  prisma: PrismaClient;
  projectId: string;
  orgId: string | null;
  userId: string | null;
  connectionId: string | null;
  sql: string;
  mode: IntelligenceMode;
  features: unknown;
  response: IntelligenceScoreResponse;
}): Promise<void> {
  const fingerprint = hashSql(normalizeSqlForHash(params.sql));
  const reasonsJson = JSON.stringify({
    reasons: params.response.reasons,
    risk_reasons: params.response.risk_reasons ?? [],
    recommendations: params.response.recommendations,
    plan_summary: params.response.plan_summary ?? null,
  });
  const featuresJson = JSON.stringify(params.features);
  const queryText = STORE_QUERY_TEXT ? redactSqlLiterals(params.sql).slice(0, 10_000) : null;

  try {
    await params.prisma.$executeRawUnsafe(
      `INSERT INTO "query_intelligence_events" (
        "project_id",
        "user_id",
        "org_id",
        "connection_id",
        "query_fingerprint",
        "score",
        "risk_level",
        "cost_bucket",
        "complexity",
        "mode",
        "reasons_json",
        "feature_summary_json",
        "query_text_encrypted"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
      params.projectId,
      params.userId,
      params.orgId,
      params.connectionId,
      fingerprint,
      params.response.performance_score,
      params.response.risk_level,
      params.response.cost_bucket,
      params.response.complexity_rating,
      params.mode,
      reasonsJson,
      featuresJson,
      queryText,
    );
    invalidateEndpointCache(params.projectId);
  } catch (err) {
    console.error("Failed to persist intelligence event", err);
  }
}

export function registerIntelligenceRoutes(options: {
  app: Express;
  prisma: PrismaClient;
  resolveProjectConnection: ResolveProjectConnectionFn;
  runConnectionQuery: RunConnectionQueryFn;
  explainTimeoutMs?: number;
}): void {
  const explainTimeoutMs =
    Number.isFinite(options.explainTimeoutMs) && (options.explainTimeoutMs ?? 0) > 0
      ? Math.round(options.explainTimeoutMs as number)
      : 2_000;

  options.app.post(
    "/api/intelligence/score",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, Partial<IntelligenceScoreRequest>>,
      res: Response<IntelligenceScoreResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const sql = typeof req.body?.sql === "string" ? normalizeSql(req.body.sql) : "";
      if (!sql) {
        return res
          .status(400)
          .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
      }

      const mode: IntelligenceMode = isIntelligenceMode(req.body?.mode) ? req.body.mode : "fast";
      const projectId =
        typeof req.body?.project_id === "string" && req.body.project_id.trim().length > 0
          ? req.body.project_id
          : null;
      if (!projectId) {
        return res
          .status(400)
          .json(makeError("INVALID_INPUT", "`project_id` is required for intelligence scoring."));
      }

      const throttle = checkThrottle({ auth, projectId, mode });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Intelligence request limit exceeded.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const features = extractQueryFeatures(sql);
      const baseResult = evaluateQueryFeatures(features, { mode, queryText: sql });

      if (mode !== "plan") {
        const projectScope = await resolveProjectScope(options.prisma, auth, projectId);
        if ("error" in projectScope) {
          return res.status(projectScope.status).json(projectScope.error);
        }
        const response: IntelligenceScoreResponse = {
          ...baseResult,
          cost_bucket: "Unknown",
        };
        await persistIntelligenceEvent({
          prisma: options.prisma,
          projectId: projectScope.projectId,
          orgId: projectScope.orgId,
          userId: auth.userId,
          connectionId: null,
          sql,
          mode: "fast",
          features,
          response,
        });
        return res.json(response);
      }

      const connectionId =
        typeof req.body?.connection_id === "string" && req.body.connection_id.trim().length > 0
          ? req.body.connection_id
          : null;
      if (!connectionId) {
        return res.status(400).json(
          makeError(
            "INVALID_INPUT",
            "`project_id` and `connection_id` are required when mode is `plan`.",
          ),
        );
      }

      const fingerprint = hashSql(normalizeSqlForHash(sql));
      const planCacheKey = `${connectionId}:${fingerprint}`;
      const cachedPlan = readPlanCache(planCacheKey);
      if (cachedPlan) {
        const projectScope = await resolveProjectScope(options.prisma, auth, projectId);
        if ("error" in projectScope) {
          return res.status(projectScope.status).json(projectScope.error);
        }
        await persistIntelligenceEvent({
          prisma: options.prisma,
          projectId: projectScope.projectId,
          orgId: projectScope.orgId,
          userId: auth.userId,
          connectionId,
          sql,
          mode: "plan",
          features,
          response: cachedPlan,
        });
        return res.json(cachedPlan);
      }

      const circuit = checkExplainCircuit(connectionId);
      if (circuit.blocked) {
        if (circuit.retryAfterSeconds) {
          res.setHeader("Retry-After", circuit.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError(
            "RATE_LIMITED",
            "Plan mode is temporarily disabled after repeated EXPLAIN timeouts.",
            {
              retry_after_seconds: circuit.retryAfterSeconds ?? null,
              reason: "explain_circuit_open",
            },
          ),
        );
      }

      const connectionContext = await options.resolveProjectConnection(auth, projectId, connectionId);
      if ("error" in connectionContext) {
        return res.status(connectionContext.status).json(connectionContext.error);
      }

      let explainJson: unknown;
      try {
        explainJson = await runExplainJson({
          connectionString: connectionContext.connectionString,
          sql,
          runConnectionQuery: options.runConnectionQuery,
          timeoutMs: explainTimeoutMs,
        });
      } catch (err) {
        if (err instanceof ExplainRunnerError) {
          if (err.code === "ANALYZER_TIMEOUT") {
            const state = recordExplainTimeout(connectionId);
            if (state.opened) {
              if (state.retryAfterSeconds) {
                res.setHeader("Retry-After", state.retryAfterSeconds.toString());
              }
              return res.status(429).json(
                makeError(
                  "RATE_LIMITED",
                  "Plan mode is temporarily disabled after repeated EXPLAIN timeouts.",
                  {
                    retry_after_seconds: state.retryAfterSeconds ?? null,
                    reason: "explain_circuit_open",
                  },
                ),
              );
            }
          }
          return res.status(err.status).json(makeError(err.code, err.message, err.details));
        }
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to run EXPLAIN."));
      }

      let planSummary: PlanSummary;
      try {
        planSummary = parsePlan(explainJson);
      } catch (err) {
        return res.status(400).json(
          makeError("INVALID_EXPLAIN_JSON", "Invalid EXPLAIN JSON output.", {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      const response = applyPlanSignals(baseResult, planSummary);
      writePlanCache(planCacheKey, response);
      clearExplainCircuit(connectionId);
      await persistIntelligenceEvent({
        prisma: options.prisma,
        projectId: connectionContext.projectId,
        orgId: connectionContext.orgId,
        userId: auth.userId,
        connectionId: connectionContext.connection.id,
        sql,
        mode: "plan",
        features,
        response,
      });
      return res.json(response);
    },
  );

  options.app.post(
    "/api/intelligence/observability/collect",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, Partial<ObservabilityCollectRequest>>,
      res: Response<ObservabilityCollectResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const projectId =
        typeof req.body?.project_id === "string" && req.body.project_id.trim().length > 0
          ? req.body.project_id
          : null;
      if (!projectId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
      }

      const connectionId =
        typeof req.body?.connection_id === "string" && req.body.connection_id.trim().length > 0
          ? req.body.connection_id
          : null;
      if (!connectionId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`connection_id` is required"));
      }

      const throttle = checkThrottle({ auth, projectId, mode: "read" });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Observability collection is rate limited.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const connectionContext = await options.resolveProjectConnection(auth, projectId, connectionId);
      if ("error" in connectionContext) {
        return res.status(connectionContext.status).json(connectionContext.error);
      }

      const snapshotTime = new Date();
      let metrics: ObservabilityCollectedMetric[];
      try {
        metrics = await collectObservabilityMetrics({
          runConnectionQuery: options.runConnectionQuery,
          connectionString: connectionContext.connectionString,
          snapshotTime,
        });
      } catch (err) {
        console.error("Failed to collect observability metrics", err);
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to collect observability metrics."));
      }

      let insertedCount = 0;
      try {
        insertedCount = await persistObservabilitySnapshots({
          prisma: options.prisma,
          projectId: connectionContext.projectId,
          snapshotTime,
          metrics,
        });
      } catch (err) {
        console.error("Failed to persist observability snapshots", err);
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to persist observability snapshots."));
      }

      const payload: ObservabilityCollectResponse = {
        project_id: connectionContext.projectId,
        connection_id: connectionContext.connection.id,
        snapshot_time: snapshotTime.toISOString(),
        inserted_count: insertedCount,
        metrics: metrics.map((metric) => ({
          metric_type: metric.metric_type,
          source: metric.source,
          rows_collected: metric.rows_collected,
          ...(metric.unavailable ? { unavailable: true } : {}),
        })),
      };
      return res.json(payload);
    },
  );

  options.app.post(
    "/api/intelligence/schema/snapshots/capture",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, Partial<SchemaSnapshotCaptureRequest>>,
      res: Response<SchemaSnapshotCaptureResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const projectId =
        typeof req.body?.project_id === "string" && req.body.project_id.trim().length > 0
          ? req.body.project_id
          : null;
      if (!projectId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
      }

      const connectionId =
        typeof req.body?.connection_id === "string" && req.body.connection_id.trim().length > 0
          ? req.body.connection_id
          : null;
      if (!connectionId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`connection_id` is required"));
      }

      const throttle = checkThrottle({ auth, projectId, mode: "read" });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Schema snapshot capture is rate limited.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const connectionContext = await options.resolveProjectConnection(auth, projectId, connectionId);
      if ("error" in connectionContext) {
        return res.status(connectionContext.status).json(connectionContext.error);
      }

      const snapshotTime = new Date();
      let schemaSnapshot: Awaited<ReturnType<typeof collectSchemaSnapshot>>;
      try {
        schemaSnapshot = await collectSchemaSnapshot({
          runConnectionQuery: options.runConnectionQuery,
          connectionString: connectionContext.connectionString,
        });
      } catch (err) {
        console.error("Failed to collect schema snapshot", err);
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to collect schema snapshot."));
      }

      let previousSnapshot: Awaited<ReturnType<typeof fetchLatestSchemaSnapshot>> = null;
      try {
        previousSnapshot = await fetchLatestSchemaSnapshot({
          prisma: options.prisma,
          projectId: connectionContext.projectId,
        });
      } catch (err) {
        console.error("Failed to load previous schema snapshot", err);
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to detect schema changes."));
      }

      let insertedCount = 0;
      try {
        insertedCount = await persistSchemaSnapshot({
          prisma: options.prisma,
          projectId: connectionContext.projectId,
          snapshotTime,
          schemaHash: schemaSnapshot.schema_hash,
          schemaJson: schemaSnapshot.schema_json,
        });
      } catch (err) {
        console.error("Failed to persist schema snapshot", err);
        return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to persist schema snapshot."));
      }

      if (previousSnapshot && previousSnapshot.schema_hash !== schemaSnapshot.schema_hash) {
        const changes = detectSchemaChanges({
          previous: previousSnapshot.schema_json,
          current: schemaSnapshot.schema_json,
        });
        if (changes.length > 0) {
          try {
            await persistSchemaChanges({
              prisma: options.prisma,
              projectId: connectionContext.projectId,
              detectedAt: snapshotTime,
              changes,
            });
          } catch (err) {
            console.error("Failed to persist schema changes", err);
            return res.status(502).json(makeError("ANALYZER_ERROR", "Failed to persist schema changes."));
          }
        }
      }

      const payload: SchemaSnapshotCaptureResponse = {
        project_id: connectionContext.projectId,
        connection_id: connectionContext.connection.id,
        snapshot_time: snapshotTime.toISOString(),
        schema_hash: schemaSnapshot.schema_hash,
        inserted_count: insertedCount,
        object_counts: schemaSnapshot.object_counts,
      };
      return res.json(payload);
    },
  );

  options.app.get(
    "/api/intelligence/history",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, unknown, { project_id?: string; page?: string; limit?: string }>,
      res: Response<IntelligenceHistoryResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const projectId =
        typeof req.query.project_id === "string" && req.query.project_id.trim().length > 0
          ? req.query.project_id
          : null;
      if (!projectId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
      }

      const projectScope = await resolveProjectScope(options.prisma, auth, projectId);
      if ("error" in projectScope) {
        return res.status(projectScope.status).json(projectScope.error);
      }

      const throttle = checkThrottle({ auth, projectId: projectScope.projectId, mode: "read" });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Intelligence request limit exceeded.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const page = parsePage(req.query.page);
      const limit = parseLimit(req.query.limit, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX);
      const cacheKey = endpointCacheKey(projectScope.projectId, "history", [
        page.toString(),
        limit.toString(),
      ]);
      const cached = readEndpointCache<IntelligenceHistoryResponse>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const offset = (page - 1) * limit;
      const countRows = await options.prisma.$queryRawUnsafe<Array<{ total: number }>>(
        `SELECT COUNT(*)::int AS total
         FROM "query_intelligence_events"
         WHERE "project_id" = $1`,
        projectScope.projectId,
      );
      const total = countRows[0]?.total ?? 0;

      const rows = await options.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          project_id: string;
          user_id: string | null;
          query_fingerprint: string;
          score: number;
          risk_level: IntelligenceScoreResponse["risk_level"];
          cost_bucket: IntelligenceScoreResponse["cost_bucket"];
          complexity: IntelligenceScoreResponse["complexity_rating"];
          mode: IntelligenceMode;
          reasons_json: unknown;
          created_at: Date;
        }>
      >(
        `SELECT
           "id",
           "project_id",
           "user_id",
           "query_fingerprint",
           "score",
           "risk_level",
           "cost_bucket",
           "complexity",
           "mode",
           "reasons_json",
           "created_at"
         FROM "query_intelligence_events"
         WHERE "project_id" = $1
         ORDER BY "created_at" DESC, "id" DESC
         LIMIT $2 OFFSET $3`,
        projectScope.projectId,
        limit,
        offset,
      );

      const payload: IntelligenceHistoryResponse = {
        project_id: projectScope.projectId,
        page,
        limit,
        total,
        has_more: offset + rows.length < total,
        events: rows.map((row) => ({
          id: row.id,
          project_id: row.project_id,
          user_id: row.user_id,
          query_fingerprint: row.query_fingerprint,
          score: row.score,
          risk_level: row.risk_level,
          cost_bucket: row.cost_bucket,
          complexity: row.complexity,
          mode: row.mode,
          reasons_json: row.reasons_json ?? null,
          created_at: new Date(row.created_at).toISOString(),
        })),
      };
      writeEndpointCache(cacheKey, payload);
      return res.json(payload);
    },
  );

  options.app.get(
    "/api/intelligence/top-risky",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, unknown, { project_id?: string; range?: string; limit?: string }>,
      res: Response<IntelligenceTopRiskyResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const projectId =
        typeof req.query.project_id === "string" && req.query.project_id.trim().length > 0
          ? req.query.project_id
          : null;
      if (!projectId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
      }
      const projectScope = await resolveProjectScope(options.prisma, auth, projectId);
      if ("error" in projectScope) {
        return res.status(projectScope.status).json(projectScope.error);
      }

      const throttle = checkThrottle({ auth, projectId: projectScope.projectId, mode: "read" });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Intelligence request limit exceeded.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const range = normalizeRange(req.query.range);
      const limit = parseLimit(req.query.limit, TOP_RISKY_LIMIT_DEFAULT, TOP_RISKY_LIMIT_MAX);
      const cacheKey = endpointCacheKey(projectScope.projectId, "top-risky", [range, limit.toString()]);
      const cached = readEndpointCache<IntelligenceTopRiskyResponse>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const { start } = resolveRangeStart(range);
      const rows = await options.prisma.$queryRawUnsafe<
        Array<{
          query_fingerprint: string;
          events_count: number;
          avg_score: number;
          min_score: number;
          last_seen_at: Date;
          risk_level: IntelligenceScoreResponse["risk_level"];
          cost_bucket: IntelligenceScoreResponse["cost_bucket"];
        }>
      >(
        `SELECT
           "query_fingerprint",
           COUNT(*)::int AS events_count,
           ROUND(AVG("score")::numeric, 1)::double precision AS avg_score,
           MIN("score")::int AS min_score,
           MAX("created_at") AS last_seen_at,
           (ARRAY_AGG("risk_level" ORDER BY "created_at" DESC))[1] AS risk_level,
           (ARRAY_AGG("cost_bucket" ORDER BY "created_at" DESC))[1] AS cost_bucket
         FROM "query_intelligence_events"
         WHERE "project_id" = $1
           AND "created_at" >= $2
           AND "risk_level" IN ('Warning', 'Dangerous')
         GROUP BY "query_fingerprint"
         ORDER BY MIN("score") ASC, COUNT(*) DESC
         LIMIT $3`,
        projectScope.projectId,
        start,
        limit,
      );

      const payload: IntelligenceTopRiskyResponse = {
        project_id: projectScope.projectId,
        range,
        items: rows.map((row) => ({
          query_fingerprint: row.query_fingerprint,
          events_count: row.events_count,
          avg_score: Number.isFinite(row.avg_score) ? Number(row.avg_score.toFixed(1)) : 0,
          min_score: row.min_score,
          risk_level: row.risk_level,
          cost_bucket: row.cost_bucket,
          last_seen_at: new Date(row.last_seen_at).toISOString(),
        })),
      };
      writeEndpointCache(cacheKey, payload);
      return res.json(payload);
    },
  );

  options.app.get(
    "/api/intelligence/trends",
    requireAuth(options.prisma),
    async (
      req: Request<unknown, unknown, unknown, { project_id?: string; range?: string }>,
      res: Response<IntelligenceTrendsResponse | ErrorResponse>,
    ) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      }

      const projectId =
        typeof req.query.project_id === "string" && req.query.project_id.trim().length > 0
          ? req.query.project_id
          : null;
      if (!projectId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
      }
      const projectScope = await resolveProjectScope(options.prisma, auth, projectId);
      if ("error" in projectScope) {
        return res.status(projectScope.status).json(projectScope.error);
      }

      const throttle = checkThrottle({ auth, projectId: projectScope.projectId, mode: "read" });
      if (throttle.limited) {
        if (throttle.retryAfterSeconds) {
          res.setHeader("Retry-After", throttle.retryAfterSeconds.toString());
        }
        return res.status(429).json(
          makeError("RATE_LIMITED", "Intelligence request limit exceeded.", {
            retry_after_seconds: throttle.retryAfterSeconds ?? null,
            reason: "intelligence_throttle",
          }),
        );
      }

      const range = normalizeRange(req.query.range);
      const cacheKey = endpointCacheKey(projectScope.projectId, "trends", [range]);
      const cached = readEndpointCache<IntelligenceTrendsResponse>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const { start, endExclusive } = resolveRangeStart(range);
      const [trendRows, riskRows, costRows, heatmapRows] = await Promise.all([
        options.prisma.$queryRawUnsafe<
          Array<{
            day: string;
            events_count: number;
            avg_score: number | null;
            dangerous_count: number;
            warning_count: number;
            safe_count: number;
          }>
        >(
          `SELECT
             TO_CHAR(DATE_TRUNC('day', "created_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS events_count,
             ROUND(AVG("score")::numeric, 1)::double precision AS avg_score,
             SUM(CASE WHEN "risk_level" = 'Dangerous' THEN 1 ELSE 0 END)::int AS dangerous_count,
             SUM(CASE WHEN "risk_level" = 'Warning' THEN 1 ELSE 0 END)::int AS warning_count,
             SUM(CASE WHEN "risk_level" = 'Safe' THEN 1 ELSE 0 END)::int AS safe_count
           FROM "query_intelligence_events"
           WHERE "project_id" = $1
             AND "created_at" >= $2
             AND "created_at" < $3
           GROUP BY 1
           ORDER BY 1 ASC`,
          projectScope.projectId,
          start,
          endExclusive,
        ),
        options.prisma.$queryRawUnsafe<Array<{ risk_level: IntelligenceScoreResponse["risk_level"]; count: number }>>(
          `SELECT "risk_level", COUNT(*)::int AS count
           FROM "query_intelligence_events"
           WHERE "project_id" = $1
             AND "created_at" >= $2
             AND "created_at" < $3
           GROUP BY "risk_level"
           ORDER BY count DESC`,
          projectScope.projectId,
          start,
          endExclusive,
        ),
        options.prisma.$queryRawUnsafe<Array<{ cost_bucket: IntelligenceScoreResponse["cost_bucket"]; count: number }>>(
          `SELECT "cost_bucket", COUNT(*)::int AS count
           FROM "query_intelligence_events"
           WHERE "project_id" = $1
             AND "created_at" >= $2
             AND "created_at" < $3
           GROUP BY "cost_bucket"
           ORDER BY count DESC`,
          projectScope.projectId,
          start,
          endExclusive,
        ),
        options.prisma.$queryRawUnsafe<Array<{ day_of_week: number; hour_of_day: number; events: number }>>(
          `SELECT
             EXTRACT(DOW FROM "created_at" AT TIME ZONE 'UTC')::int AS day_of_week,
             EXTRACT(HOUR FROM "created_at" AT TIME ZONE 'UTC')::int AS hour_of_day,
             COUNT(*)::int AS events
           FROM "query_intelligence_events"
           WHERE "project_id" = $1
             AND "created_at" >= $2
             AND "created_at" < $3
           GROUP BY 1, 2
           ORDER BY 1 ASC, 2 ASC`,
          projectScope.projectId,
          start,
          endExclusive,
        ),
      ]);

      const trendByDay = new Map(trendRows.map((row) => [row.day, row]));
      const days = range === "30d" ? 30 : 7;
      const points: IntelligenceTrendsResponse["points"] = [];
      for (let offset = 0; offset < days; offset += 1) {
        const day = new Date(start);
        day.setUTCDate(start.getUTCDate() + offset);
        const date = day.toISOString().slice(0, 10);
        const row = trendByDay.get(date);
        points.push({
          date,
          events: row?.events_count ?? 0,
          avg_score:
            typeof row?.avg_score === "number" && Number.isFinite(row.avg_score)
              ? Number(row.avg_score.toFixed(1))
              : null,
          dangerous: row?.dangerous_count ?? 0,
          warning: row?.warning_count ?? 0,
          safe: row?.safe_count ?? 0,
        });
      }

      const payload: IntelligenceTrendsResponse = {
        project_id: projectScope.projectId,
        range,
        points,
        risk_distribution: riskRows.map((row) => ({ risk_level: row.risk_level, count: row.count })),
        cost_distribution: costRows.map((row) => ({ cost_bucket: row.cost_bucket, count: row.count })),
        heatmap: heatmapRows.map((row) => ({
          day_of_week: row.day_of_week,
          hour_of_day: row.hour_of_day,
          events: row.events,
        })),
      };

      writeEndpointCache(cacheKey, payload);
      return res.json(payload);
    },
  );
}
