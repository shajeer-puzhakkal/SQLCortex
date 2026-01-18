import { hashSql, normalizeSql } from "../../../packages/shared/src";

type RateBucket = {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
};

type DailyBucket = {
  dateKey: string;
  count: number;
  lastSeenMs: number;
};

type DuplicateBucket = {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
};

const WINDOW_MS = 60_000;
const DUPLICATE_WINDOW_MS = Number(process.env.AI_DUPLICATE_WINDOW_MS ?? 60_000);
const DUPLICATE_MAX = Number(process.env.AI_DUPLICATE_MAX ?? 3);
const DAILY_CAP = Number(process.env.AI_DAILY_CAP ?? 500);
const AI_RATE_LIMIT_PER_MIN = Number(process.env.AI_RATE_LIMIT_PER_MIN ?? 60);
const MAX_BUCKETS = 20_000;
const BUCKET_TTL_MS = 10 * 60_000;

const rateBuckets = new Map<string, RateBucket>();
const duplicateBuckets = new Map<string, DuplicateBucket>();
const dailyBuckets = new Map<string, DailyBucket>();

function cleanupBuckets<T extends { lastSeenMs: number }>(buckets: Map<string, T>, nowMs: number) {
  if (buckets.size <= MAX_BUCKETS) {
    return;
  }
  for (const [key, bucket] of buckets.entries()) {
    if (nowMs - bucket.lastSeenMs > BUCKET_TTL_MS) {
      buckets.delete(key);
    }
  }
}

function normalizeLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getDateKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;
}

export function computeSqlHash(sql: string): string {
  return hashSql(normalizeSql(sql));
}

export function checkAiRateLimit(key: string, nowMs: number = Date.now()): {
  limited: boolean;
  retryAfterSeconds?: number;
} {
  const limit = normalizeLimit(AI_RATE_LIMIT_PER_MIN, 60);
  cleanupBuckets(rateBuckets, nowMs);

  const existing = rateBuckets.get(key);
  if (!existing || nowMs - existing.windowStartMs >= WINDOW_MS) {
    rateBuckets.set(key, { windowStartMs: nowMs, count: 1, lastSeenMs: nowMs });
    return { limited: false };
  }

  existing.lastSeenMs = nowMs;
  if (existing.count + 1 > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.windowStartMs + WINDOW_MS - nowMs) / 1000)
    );
    return { limited: true, retryAfterSeconds };
  }

  existing.count += 1;
  return { limited: false };
}

export function checkDailyCap(key: string, now: Date = new Date()): { limited: boolean } {
  const cap = normalizeLimit(DAILY_CAP, 500);
  const nowMs = now.getTime();
  cleanupBuckets(dailyBuckets, nowMs);

  const dateKey = getDateKey(now);
  const existing = dailyBuckets.get(key);
  if (!existing || existing.dateKey !== dateKey) {
    dailyBuckets.set(key, { dateKey, count: 1, lastSeenMs: nowMs });
    return { limited: false };
  }

  existing.lastSeenMs = nowMs;
  if (existing.count + 1 > cap) {
    return { limited: true };
  }

  existing.count += 1;
  return { limited: false };
}

export function checkDuplicateRequest(params: {
  key: string;
  sqlHash: string;
  nowMs?: number;
}): { limited: boolean } {
  const limit = normalizeLimit(DUPLICATE_MAX, 3);
  const windowMs = normalizeLimit(DUPLICATE_WINDOW_MS, 60_000);
  const nowMs = params.nowMs ?? Date.now();
  cleanupBuckets(duplicateBuckets, nowMs);

  const bucketKey = `${params.key}:${params.sqlHash}`;
  const existing = duplicateBuckets.get(bucketKey);
  if (!existing || nowMs - existing.windowStartMs >= windowMs) {
    duplicateBuckets.set(bucketKey, { windowStartMs: nowMs, count: 1, lastSeenMs: nowMs });
    return { limited: false };
  }

  existing.lastSeenMs = nowMs;
  if (existing.count + 1 > limit) {
    return { limited: true };
  }

  existing.count += 1;
  return { limited: false };
}
