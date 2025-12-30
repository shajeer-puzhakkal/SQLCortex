import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { makeError } from "./contracts";
import { getPlanContext, suggestedUpgradeForPlan } from "./plans";
import { logAnalysisTelemetry } from "./telemetry";
import type { AuthenticatedRequest } from "./auth";

type Bucket = {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
};

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 20_000;
const BUCKET_TTL_MS = 10 * 60_000;

function cleanupBuckets(buckets: Map<string, Bucket>, nowMs: number) {
  if (buckets.size <= MAX_BUCKETS) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (nowMs - bucket.lastSeenMs > BUCKET_TTL_MS) {
      buckets.delete(key);
    }
  }
}

export function createRateLimitMiddleware(prisma: PrismaClient) {
  const buckets = new Map<string, Bucket>();

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/v1/")) {
      next();
      return;
    }

    if (req.path.startsWith("/api/v1/auth/")) {
      next();
      return;
    }

    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      next();
      return;
    }

    const key =
      auth.tokenId
        ? `token:${auth.tokenId}`
        : auth.userId
          ? `user:${auth.userId}`
          : auth.orgId
            ? `org:${auth.orgId}`
            : null;
    if (!key) {
      next();
      return;
    }

    const subject =
      auth.subjectType === "ORG" && auth.orgId
        ? ({ subjectType: "ORG", orgId: auth.orgId } as const)
        : auth.userId
          ? ({ subjectType: "USER", userId: auth.userId } as const)
          : auth.orgId
            ? ({ subjectType: "ORG", orgId: auth.orgId } as const)
            : null;

    if (!subject) {
      next();
      return;
    }

    const { plan, planCode } = await getPlanContext(prisma, subject);
    const limit = plan.apiRateLimitPerMin;

    const nowMs = Date.now();
    cleanupBuckets(buckets, nowMs);

    const existing = buckets.get(key);
    if (!existing || nowMs - existing.windowStartMs >= WINDOW_MS) {
      buckets.set(key, { windowStartMs: nowMs, count: 1, lastSeenMs: nowMs });
      next();
      return;
    }

    existing.lastSeenMs = nowMs;
    if (existing.count + 1 > limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.windowStartMs + WINDOW_MS - nowMs) / 1000)
      );
      res.setHeader("Retry-After", retryAfterSeconds.toString());
      if (req.path.startsWith("/api/v1/analyses")) {
        logAnalysisTelemetry({
          analysisId: null,
          projectId: null,
          userId: auth.userId ?? null,
          orgId: auth.orgId ?? null,
          analyzerDurationMs: null,
          analyzerErrorCode: "RATE_LIMITED",
          quotaDenied: false,
          rateLimited: true,
          llmUsed: false,
        });
      }
      res.status(429).json(
        makeError("RATE_LIMITED", "Rate limit exceeded for current plan.", {
          limit_per_min: limit,
          plan: planCode,
          suggested_plan: suggestedUpgradeForPlan(planCode),
          retry_after_seconds: retryAfterSeconds,
        })
      );
      return;
    }

    existing.count += 1;
    next();
  };
}
