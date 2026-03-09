import type { PrismaClient } from "@prisma/client";
import type { Express, Request, Response } from "express";
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

const HISTORY_LIMIT_DEFAULT = 25;
const HISTORY_LIMIT_MAX = 100;
const TOP_RISKY_LIMIT_DEFAULT = 10;
const TOP_RISKY_LIMIT_MAX = 25;
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
