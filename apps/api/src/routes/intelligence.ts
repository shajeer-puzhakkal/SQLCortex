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
import type {
  IntelligenceMode,
  IntelligenceScoreRequest,
  IntelligenceScoreResponse,
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
      const features = extractQueryFeatures(sql);
      const baseResult = evaluateQueryFeatures(features, { mode, queryText: sql });

      if (mode !== "plan") {
        return res.json({
          ...baseResult,
          cost_bucket: "Unknown",
        });
      }

      const projectId =
        typeof req.body?.project_id === "string" && req.body.project_id.trim().length > 0
          ? req.body.project_id
          : null;
      const connectionId =
        typeof req.body?.connection_id === "string" && req.body.connection_id.trim().length > 0
          ? req.body.connection_id
          : null;
      if (!projectId || !connectionId) {
        return res.status(400).json(
          makeError(
            "INVALID_INPUT",
            "`project_id` and `connection_id` are required when mode is `plan`.",
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
      return res.json(response);
    },
  );
}
