import express, { NextFunction, Request, Response } from "express";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import { OrgRole, Prisma, PrismaClient } from "@prisma/client";
import {
  AnalyzeRequest,
  AnalyzeResponse,
  AnalysisCreateRequest,
  AnalysisCreateResponse,
  AnalysisGetResponse,
  AnalysisListResponse,
  AiSqlResponse,
  ErrorResponse,
  HealthResponse,
  ExplainMode,
  PlanSummary,
  makeError,
  mapAnalysisToResource,
} from "./contracts";
import { AiServiceError, AiSqlAction, AiSqlPayload, callAiSqlService } from "./aiClient";
import {
  ensureDefaultPlans,
  getPlanContext,
  suggestedUpgradeForPlan,
  PlanCode,
  PlanSubject,
} from "./plans";
import {
  checkSqlAndExplainSizeLimits,
  countOrgMembersAndPendingInvites,
  countProjectsForSubject,
  getAnalysesUsedThisMonth,
  getLlmCallsUsedThisMonth,
  incrementAnalysesThisMonth,
  incrementLlmCallsThisMonth,
  makePlanLimitExceededError,
} from "./quota";
import {
  attachAuth,
  AuthenticatedRequest,
  clearSessionCookie,
  createOpaqueToken,
  createSession,
  getSessionToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from "./auth";
import { createRateLimitMiddleware } from "./rateLimit";
import { logAiSqlTelemetry, logAnalysisTelemetry } from "./telemetry";
import { recordMeterEvent } from "./metering";
import { redactError } from "../../../packages/shared/src";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

const defaultAnalyzerPort = process.env.ANALYZER_PORT ?? 8000;
const analyzerBaseUrl =
  process.env.ANALYZER_BASE_URL ??
  process.env.ANALYZER_URL ??
  `http://ai-services:${defaultAnalyzerPort}`;
const analyzerTimeoutMsEnv = Number(
  process.env.ANALYZER_TIMEOUT_MS ?? process.env.ANALYZER_TIMEOUT ?? 8000
);
const ANALYZER_TIMEOUT_MS =
  Number.isFinite(analyzerTimeoutMsEnv) && analyzerTimeoutMsEnv > 0
    ? analyzerTimeoutMsEnv
    : 8000;
const ANALYSIS_HISTORY_LIMIT = 50;
const queryTimeoutMsEnv = Number(
  process.env.QUERY_TIMEOUT_MS ?? process.env.QUERY_TIMEOUT ?? 10000
);
const QUERY_TIMEOUT_MS =
  Number.isFinite(queryTimeoutMsEnv) && queryTimeoutMsEnv > 0
    ? queryTimeoutMsEnv
    : 10000;
const QUERY_ROW_LIMIT = Number(process.env.QUERY_ROW_LIMIT ?? 1000) || 1000;
const queryDatabaseUrl = process.env.QUERY_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const queryPrisma =
  queryDatabaseUrl &&
  process.env.DATABASE_URL &&
  queryDatabaseUrl !== process.env.DATABASE_URL
    ? new PrismaClient({ datasources: { db: { url: queryDatabaseUrl } } })
    : prisma;
const schemaCacheTtlSecondsEnv = Number(
  process.env.SCHEMA_CACHE_TTL_SECONDS ?? process.env.SCHEMA_CACHE_TTL ?? 60
);
const SCHEMA_CACHE_TTL_SECONDS = Number.isFinite(schemaCacheTtlSecondsEnv)
  ? Math.min(Math.max(schemaCacheTtlSecondsEnv, 30), 120)
  : 60;
const SCHEMA_CACHE_TTL_MS = SCHEMA_CACHE_TTL_SECONDS * 1000;
const schemaQueryTimeoutMsEnv = Number(
  process.env.SCHEMA_QUERY_TIMEOUT_MS ??
    process.env.SCHEMA_INTROSPECTION_TIMEOUT_MS ??
    5000
);
const SCHEMA_QUERY_TIMEOUT_MS =
  Number.isFinite(schemaQueryTimeoutMsEnv) && schemaQueryTimeoutMsEnv > 0
    ? schemaQueryTimeoutMsEnv
    : 5000;
const schemaRateLimitPerMinEnv = Number(
  process.env.SCHEMA_RATE_LIMIT_PER_MIN ?? process.env.SCHEMA_RATE_LIMIT ?? 60
);
const SCHEMA_RATE_LIMIT_PER_MIN =
  Number.isFinite(schemaRateLimitPerMinEnv) && schemaRateLimitPerMinEnv > 0
    ? schemaRateLimitPerMinEnv
    : 60;
const schemaCacheMaxEntriesEnv = Number(process.env.SCHEMA_CACHE_MAX_ENTRIES ?? 5000);
const SCHEMA_CACHE_MAX_ENTRIES =
  Number.isFinite(schemaCacheMaxEntriesEnv) && schemaCacheMaxEntriesEnv > 0
    ? schemaCacheMaxEntriesEnv
    : 5000;

const CONNECTION_ENCRYPTION_ALGO = "aes-256-gcm";
const CONNECTION_ENCRYPTION_VERSION = 1;
const CONNECTION_ENCRYPTION_IV_BYTES = 12;
const CONNECTION_TYPE_POSTGRES = "postgres";
const ALLOWED_SSL_MODES = ["require", "disable", "prefer", "verify-ca", "verify-full"] as const;
type SslMode = (typeof ALLOWED_SSL_MODES)[number];
const DEFAULT_SSL_MODE: SslMode = "require";
let cachedConnectionEncryptionKey: Buffer | null = null;

const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const SubjectType = {
  USER: "USER",
  ORG: "ORG",
} as const;
type SubjectType = (typeof SubjectType)[keyof typeof SubjectType];

type ProjectContext =
  | {
      projectId: string | null;
      orgId: string | null;
      project?: {
        id: string;
        orgId: string | null;
        ownerUserId: string | null;
        name: string;
        aiEnabled: boolean;
        orgAiEnabled: boolean | null;
      };
    }
  | { error: ErrorResponse; status: number };

type AnalyzerResultPayload = {
  analysis: {
    result: Prisma.InputJsonValue | null;
    status?: string | null;
  };
};

type AnalyzerError = {
  status: number;
  payload: ErrorResponse;
};

type ExecuteQueryRequest = {
  projectId?: string | null;
  connectionId?: string | null;
  sql?: string;
  source?: string;
  client?: { extensionVersion?: string; vscodeVersion?: string };
};

type AiSqlRequestBody = {
  project_id?: string | null;
  connection_id?: string | null;
  sql?: string;
  user_intent?: string | null;
  explain_mode?: ExplainMode;
};

type ExecuteQueryResponse = {
  queryId: string;
  executionTimeMs: number;
  rowsReturned: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<unknown>>;
  error: ErrorResponse | null;
};

type ConnectionCredentials = {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  url?: string;
};

type EncryptedCredentialsPayload = {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  data: string;
};

type ConnectionResource = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  ssl_mode: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  uses_url: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
};

type SchemaCacheEntry<T> = {
  expiresAt: number;
  payload: T;
};

type SchemaTableResource = { name: string; type: "table" | "view" };
type SchemaColumnResource = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
};

type AnalysisResultValue = Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;

type AiFeatureStatus = {
  enabled: boolean;
  reason: "org_disabled" | "project_disabled" | null;
};

type LlmAccessStatus = {
  enabled: boolean;
  reason: "plan_disabled" | "limit_reached" | null;
  used: number | null;
  limit: number | null;
};

type AiSqlFallbackReason =
  | "org_disabled"
  | "project_disabled"
  | "plan_disabled"
  | "limit_reached"
  | "service_unavailable";

function resolveAiFeatureStatusFromProject(
  project?: ProjectContext["project"] | null
): AiFeatureStatus {
  if (!project) {
    return { enabled: true, reason: null };
  }
  if (project.orgId && project.orgAiEnabled === false) {
    return { enabled: false, reason: "org_disabled" };
  }
  if (!project.aiEnabled) {
    return { enabled: false, reason: "project_disabled" };
  }
  return { enabled: true, reason: null };
}

async function resolveAiFeatureStatusForContext(
  prismaClient: PrismaClient,
  projectContext: ProjectContext
): Promise<AiFeatureStatus> {
  const direct = resolveAiFeatureStatusFromProject(projectContext.project ?? null);
  if (!direct.enabled) {
    return direct;
  }

  if (!projectContext.project && projectContext.orgId) {
    const org = await prismaClient.organization.findUnique({
      where: { id: projectContext.orgId },
      select: { aiEnabled: true },
    });
    if (org && !org.aiEnabled) {
      return { enabled: false, reason: "org_disabled" };
    }
  }

  return direct;
}

async function resolveLlmAccess(
  prismaClient: PrismaClient,
  subject: PlanSubject,
  plan: { llmEnabled: boolean; monthlyLlmCallLimit: number },
  now: Date
): Promise<LlmAccessStatus> {
  const limit = plan.monthlyLlmCallLimit;
  if (!plan.llmEnabled) {
    return { enabled: false, reason: "plan_disabled", used: null, limit };
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return { enabled: false, reason: "limit_reached", used: 0, limit };
  }

  const used = await getLlmCallsUsedThisMonth(prismaClient, subject, now);
  if (used >= limit) {
    return { enabled: false, reason: "limit_reached", used, limit };
  }

  return { enabled: true, reason: null, used, limit };
}

function buildAiSqlFallbackResponse(params: {
  reason: AiSqlFallbackReason;
  planCode?: PlanCode | null;
  used?: number | null;
  limit?: number | null;
}): AiSqlResponse {
  const suggestedPlan = params.planCode ? suggestedUpgradeForPlan(params.planCode) : null;
  let summary = "AI response is unavailable.";
  let recommendations: string[] = [];

  switch (params.reason) {
    case "org_disabled":
      summary = "AI is disabled for this organization.";
      recommendations = ["Ask an org admin to enable AI for this organization."];
      break;
    case "project_disabled":
      summary = "AI is disabled for this project.";
      recommendations = ["Enable AI in the project settings to use this feature."];
      break;
    case "plan_disabled":
      summary = "AI is disabled for your current plan.";
      recommendations = [
        suggestedPlan ? `Upgrade to ${suggestedPlan} to enable AI features.` : "Upgrade your plan to enable AI features.",
      ];
      break;
    case "limit_reached": {
      const limit = typeof params.limit === "number" ? params.limit : null;
      const used = typeof params.used === "number" ? params.used : null;
      summary =
        limit !== null && used !== null
          ? `AI usage limit reached (${used}/${limit}) for this period.`
          : "AI usage limit reached for this period.";
      recommendations = [
        suggestedPlan
          ? `Upgrade to ${suggestedPlan} or wait for the limit to reset.`
          : "Try again after the limit resets or upgrade your plan.",
      ];
      break;
    }
    case "service_unavailable":
      summary = "AI service is temporarily unavailable.";
      recommendations = ["Retry in a few minutes."];
      break;
    default:
      break;
  }

  const provider = params.reason === "service_unavailable" ? "unavailable" : "disabled";

  return {
    summary,
    findings: [],
    recommendations,
    risk_level: "low",
    meta: { provider, model: "n/a", latency_ms: 0 },
  };
}

function toJsonResult(value: unknown): AnalysisResultValue {
  if (value === null || typeof value === "undefined") {
    return Prisma.JsonNull;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return Prisma.JsonNull;
  }
}

function decodeEncryptionKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const base64Key = Buffer.from(trimmed, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }
  const hexKey = Buffer.from(trimmed, "hex");
  if (hexKey.length === 32) {
    return hexKey;
  }
  return null;
}

function getConnectionEncryptionKey(): Buffer {
  if (cachedConnectionEncryptionKey) {
    return cachedConnectionEncryptionKey;
  }
  const rawKey = process.env.DB_CONNECTIONS_ENCRYPTION_KEY ?? "";
  const decoded = decodeEncryptionKey(rawKey);
  if (!decoded) {
    throw new Error("DB_CONNECTIONS_ENCRYPTION_KEY must be a 32-byte base64 or hex string");
  }
  cachedConnectionEncryptionKey = decoded;
  return decoded;
}

function encryptCredentials(credentials: ConnectionCredentials): Prisma.InputJsonValue {
  const key = getConnectionEncryptionKey();
  const iv = randomBytes(CONNECTION_ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(CONNECTION_ENCRYPTION_ALGO, key, iv);
  const plaintext = JSON.stringify(credentials);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: CONNECTION_ENCRYPTION_VERSION,
    alg: CONNECTION_ENCRYPTION_ALGO,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptCredentials(payload: Prisma.JsonValue): ConnectionCredentials {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Encrypted credentials payload is invalid");
  }
  const record = payload as Record<string, unknown>;
  const version = typeof record.v === "number" ? record.v : null;
  const alg = typeof record.alg === "string" ? record.alg : null;
  const iv = typeof record.iv === "string" ? record.iv : null;
  const tag = typeof record.tag === "string" ? record.tag : null;
  const data = typeof record.data === "string" ? record.data : null;

  if (version !== CONNECTION_ENCRYPTION_VERSION || alg !== CONNECTION_ENCRYPTION_ALGO) {
    throw new Error("Encrypted credentials payload is unsupported");
  }
  if (!iv || !tag || !data) {
    throw new Error("Encrypted credentials payload is incomplete");
  }

  const ivBuffer = Buffer.from(iv, "base64");
  const tagBuffer = Buffer.from(tag, "base64");
  const dataBuffer = Buffer.from(data, "base64");
  if (
    ivBuffer.length !== CONNECTION_ENCRYPTION_IV_BYTES ||
    tagBuffer.length === 0 ||
    dataBuffer.length === 0
  ) {
    throw new Error("Encrypted credentials payload is malformed");
  }

  const key = getConnectionEncryptionKey();
  const decipher = createDecipheriv(CONNECTION_ENCRYPTION_ALGO, key, ivBuffer);
  decipher.setAuthTag(tagBuffer);
  const decrypted = Buffer.concat([decipher.update(dataBuffer), decipher.final()]);
  const parsed = JSON.parse(decrypted.toString("utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Decrypted credentials payload is invalid");
  }
  return parsed as ConnectionCredentials;
}

function normalizeSslMode(value?: string | null): SslMode | null {
  if (!value) {
    return DEFAULT_SSL_MODE;
  }
  const normalized = value.trim().toLowerCase();
  return ALLOWED_SSL_MODES.includes(normalized as SslMode)
    ? (normalized as SslMode)
    : null;
}

function maskValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 2) {
    return "*".repeat(trimmed.length);
  }
  const prefix = trimmed.slice(0, 2);
  const suffix = trimmed.slice(-2);
  return `${prefix}${"*".repeat(Math.min(6, trimmed.length - 2))}${suffix}`;
}

function extractConnectionDisplay(credentials: ConnectionCredentials): {
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  usesUrl: boolean;
  hasPassword: boolean;
} {
  if (credentials.url) {
    try {
      const parsed = new URL(credentials.url);
      const database = parsed.pathname?.replace(/^\//, "") || null;
      const username = parsed.username || null;
      const password = parsed.password || null;
      const port = parsed.port ? Number(parsed.port) : null;
      return {
        host: parsed.hostname || null,
        port: Number.isFinite(port) ? port : null,
        database,
        username,
        usesUrl: true,
        hasPassword: Boolean(password),
      };
    } catch {
      return {
        host: null,
        port: null,
        database: null,
        username: null,
        usesUrl: true,
        hasPassword: false,
      };
    }
  }

  return {
    host: credentials.host ?? null,
    port: typeof credentials.port === "number" ? credentials.port : null,
    database: credentials.database ?? null,
    username: credentials.username ?? null,
    usesUrl: false,
    hasPassword: Boolean(credentials.password),
  };
}

function mapConnectionResource(record: {
  id: string;
  projectId: string;
  type: string;
  name: string;
  sslMode: string;
  createdAt: Date;
  updatedAt: Date;
}, credentials: ConnectionCredentials): ConnectionResource {
  const display = extractConnectionDisplay(credentials);
  return {
    id: record.id,
    project_id: record.projectId,
    type: record.type,
    name: record.name,
    ssl_mode: record.sslMode,
    host: maskValue(display.host),
    port: display.port ?? null,
    database: maskValue(display.database),
    username: maskValue(display.username),
    uses_url: display.usesUrl,
    has_password: display.hasPassword,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

function applySslModeToUrl(rawUrl: string, sslMode: SslMode): string {
  const parsed = new URL(rawUrl);
  parsed.searchParams.set("sslmode", sslMode);
  if (!parsed.searchParams.has("connect_timeout")) {
    parsed.searchParams.set("connect_timeout", "5");
  }
  return parsed.toString();
}

function buildConnectionString(
  credentials: ConnectionCredentials,
  sslMode: SslMode
): string {
  const baseUrl = credentials.url
    ? credentials.url
    : (() => {
        const url = new URL("postgresql://");
        if (!credentials.host) {
          throw new Error("Host is required");
        }
        url.hostname = credentials.host;
        if (credentials.port) {
          url.port = String(credentials.port);
        }
        if (credentials.database) {
          url.pathname = `/${credentials.database}`;
        }
        if (credentials.username) {
          url.username = credentials.username;
        }
        if (credentials.password) {
          url.password = credentials.password;
        }
        return url.toString();
      })();

  return applySslModeToUrl(baseUrl, sslMode);
}

function sanitizeConnectionError(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://***@");
}

async function testPostgresConnection(connectionString: string): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: connectionString } } });
  try {
    await client.$connect();
    await client.$queryRaw`SELECT 1`;
  } finally {
    await client.$disconnect();
  }
}

const schemaCache = new Map<string, SchemaCacheEntry<unknown>>();
const schemaRateBuckets = new Map<
  string,
  { windowStartMs: number; count: number; lastSeenMs: number }
>();
const SCHEMA_RATE_WINDOW_MS = 60_000;
const SCHEMA_RATE_BUCKET_TTL_MS = 10 * 60_000;

function cleanupSchemaRateBuckets(nowMs: number) {
  if (schemaRateBuckets.size <= 20_000) {
    return;
  }

  for (const [key, bucket] of schemaRateBuckets.entries()) {
    if (nowMs - bucket.lastSeenMs > SCHEMA_RATE_BUCKET_TTL_MS) {
      schemaRateBuckets.delete(key);
    }
  }
}

function checkSchemaRateLimit(params: {
  auth: NonNullable<AuthenticatedRequest["auth"]>;
  projectId: string;
  connectionId: string;
}): { limited: boolean; retryAfterSeconds?: number } {
  const subjectKey =
    params.auth.tokenId
      ? `token:${params.auth.tokenId}`
      : params.auth.userId
        ? `user:${params.auth.userId}`
        : params.auth.orgId
          ? `org:${params.auth.orgId}`
          : null;
  if (!subjectKey) {
    return { limited: false };
  }

  const key = `schema:${subjectKey}:${params.projectId}:${params.connectionId}`;
  const nowMs = Date.now();
  cleanupSchemaRateBuckets(nowMs);

  const existing = schemaRateBuckets.get(key);
  if (!existing || nowMs - existing.windowStartMs >= SCHEMA_RATE_WINDOW_MS) {
    schemaRateBuckets.set(key, { windowStartMs: nowMs, count: 1, lastSeenMs: nowMs });
    return { limited: false };
  }

  existing.lastSeenMs = nowMs;
  if (existing.count + 1 > SCHEMA_RATE_LIMIT_PER_MIN) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.windowStartMs + SCHEMA_RATE_WINDOW_MS - nowMs) / 1000)
    );
    return { limited: true, retryAfterSeconds };
  }

  existing.count += 1;
  return { limited: false };
}

function schemaCacheKey(connectionId: string, path: string, parts: string[] = []): string {
  return `schema:${connectionId}:${path}:${parts.join(":")}`;
}

function cleanupSchemaCache(nowMs: number) {
  for (const [key, entry] of schemaCache.entries()) {
    if (entry.expiresAt <= nowMs) {
      schemaCache.delete(key);
    }
  }

  if (schemaCache.size <= SCHEMA_CACHE_MAX_ENTRIES) {
    return;
  }

  const overflow = schemaCache.size - SCHEMA_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of schemaCache.keys()) {
    schemaCache.delete(key);
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
}

function readSchemaCache<T>(key: string): T | null {
  const entry = schemaCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    schemaCache.delete(key);
    return null;
  }
  return entry.payload as T;
}

function writeSchemaCache<T>(key: string, payload: T): void {
  const nowMs = Date.now();
  cleanupSchemaCache(nowMs);
  schemaCache.set(key, { expiresAt: nowMs + SCHEMA_CACHE_TTL_MS, payload });
}

function clearSchemaCache(connectionId: string): void {
  const prefix = `schema:${connectionId}:`;
  for (const key of schemaCache.keys()) {
    if (key.startsWith(prefix)) {
      schemaCache.delete(key);
    }
  }
}

function isTruthyParam(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function runSchemaQuery<T>(
  connectionString: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const client = new PrismaClient({ datasources: { db: { url: connectionString } } });
  try {
    await client.$connect();
    return await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${SCHEMA_QUERY_TIMEOUT_MS}`);
      await tx.$executeRawUnsafe("SET LOCAL default_transaction_read_only = on");
      return fn(tx);
    });
  } finally {
    await client.$disconnect();
  }
}

async function runConnectionQuery<T>(
  connectionString: string,
  sql: string
): Promise<T> {
  const client = new PrismaClient({ datasources: { db: { url: connectionString } } });
  try {
    await client.$connect();
    return await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
      await tx.$executeRawUnsafe("SET LOCAL default_transaction_read_only = on");
      return tx.$queryRawUnsafe(sql) as Promise<T>;
    });
  } finally {
    await client.$disconnect();
  }
}

async function resolveProjectConnection(
  auth: NonNullable<AuthenticatedRequest["auth"]>,
  projectId: string,
  connectionId: string
): Promise<
  | { error: ErrorResponse; status: number }
  | {
      projectId: string;
      orgId: string | null;
      project: NonNullable<ProjectContext["project"]>;
      connection: {
        id: string;
        projectId: string;
        type: string;
        sslMode: string;
      };
      connectionString: string;
    }
> {
  const projectContext = await resolveProjectContext(auth, projectId);
  if ("error" in projectContext) {
    return { error: projectContext.error, status: projectContext.status };
  }

  if (!projectContext.projectId) {
    return { error: makeError("INVALID_INPUT", "Project not found"), status: 400 };
  }
  if (!projectContext.project) {
    return { error: makeError("INVALID_INPUT", "Project context missing"), status: 400 };
  }

  const connection = await prisma.projectDbConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, projectId: true, type: true, sslMode: true, encryptedCredentials: true },
  });
  if (!connection || connection.projectId !== projectContext.projectId) {
    return { error: makeError("INVALID_INPUT", "Connection not found"), status: 404 };
  }

  if (connection.type !== CONNECTION_TYPE_POSTGRES) {
    return {
      error: makeError("INVALID_INPUT", "Only postgres connections are supported"),
      status: 400,
    };
  }

  let credentials: ConnectionCredentials;
  try {
    credentials = decryptCredentials(connection.encryptedCredentials);
  } catch (err) {
    console.error("Failed to decrypt connection credentials", err);
    return { error: makeError("ANALYZER_ERROR", "Failed to decrypt connection"), status: 500 };
  }

  const sslMode = normalizeSslMode(connection.sslMode) ?? DEFAULT_SSL_MODE;
  let connectionString: string;
  try {
    connectionString = buildConnectionString(credentials, sslMode);
  } catch (err) {
    return {
      error: makeError("INVALID_INPUT", "Connection credentials are incomplete"),
      status: 400,
    };
  }

  return {
    projectId: projectContext.projectId,
    orgId: projectContext.orgId,
    project: projectContext.project,
    connection,
    connectionString,
  };
}

function handleSchemaRateLimit(
  res: Response,
  rateLimit: { limited: boolean; retryAfterSeconds?: number }
): boolean {
  if (!rateLimit.limited) {
    return false;
  }
  if (rateLimit.retryAfterSeconds) {
    res.setHeader("Retry-After", rateLimit.retryAfterSeconds.toString());
  }
  res.status(429).json(
    makeError("RATE_LIMITED", "Schema introspection rate limit exceeded.", {
      retry_after_seconds: rateLimit.retryAfterSeconds ?? null,
    })
  );
  return true;
}

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json());
app.use(attachAuth(prisma));
app.use(createRateLimitMiddleware(prisma));

const ALLOWED_QUERY_START_KEYWORDS = ["select", "with", "explain"] as const;
const BLOCKED_QUERY_KEYWORDS = [
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
] as const;
const EXPLAIN_MODE_VALUES = ["EXPLAIN", "EXPLAIN_ANALYZE"] as const;
const AI_SQL_ACTIONS = ["explain", "optimize", "index-suggest", "risk-check"] as const;

function isReadOnlySql(sql: string): boolean {
  const cleaned = stripSqlCommentsAndLiterals(sql);
  const normalized = cleaned.trim();
  if (!normalized) {
    return false;
  }

  const withoutTrailingSemicolons = normalized.replace(/;+\s*$/, "");
  if (withoutTrailingSemicolons.includes(";")) {
    return false;
  }

  if (matchBlockedKeyword(withoutTrailingSemicolons)) {
    return false;
  }

  const firstKeyword = extractFirstKeyword(withoutTrailingSemicolons);
  if (!firstKeyword) {
    return false;
  }

  const normalizedKeyword = firstKeyword.toLowerCase();
  return ALLOWED_QUERY_START_KEYWORDS.includes(
    normalizedKeyword as (typeof ALLOWED_QUERY_START_KEYWORDS)[number]
  );
}

function normalizeExplainMode(value: unknown): ExplainMode {
  if (typeof value !== "string") {
    return "EXPLAIN";
  }
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "_");
  return EXPLAIN_MODE_VALUES.includes(normalized as ExplainMode)
    ? (normalized as ExplainMode)
    : "EXPLAIN";
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function stripSqlCommentsAndLiterals(sql: string): string {
  const withoutLineComments = sql.replace(/--.*?$/gm, " ");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutStrings = withoutBlockComments
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\"\"|[^\"])*"/g, "\"\"");
  return withoutStrings;
}

function extractFirstKeyword(sql: string): string | null {
  const match = sql.match(/\b([a-zA-Z]+)\b/);
  return match?.[1] ?? null;
}

function matchBlockedKeyword(sql: string): string | null {
  const pattern = new RegExp(`\\b(${BLOCKED_QUERY_KEYWORDS.join("|")})\\b`, "i");
  const match = sql.match(pattern);
  return match?.[1] ?? null;
}

function hasProhibitedClauses(sql: string): boolean {
  const cleaned = stripSqlCommentsAndLiterals(sql).toLowerCase();
  return (
    /\binto\b/.test(cleaned) ||
    /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(cleaned)
  );
}

function isAiSqlAction(value: string): value is AiSqlAction {
  return AI_SQL_ACTIONS.includes(value as AiSqlAction);
}

function applyRowLimit(sql: string): string {
  const normalized = normalizeSql(sql);
  const cleaned = stripSqlCommentsAndLiterals(normalized).toLowerCase();
  const firstKeyword = extractFirstKeyword(cleaned);
  if (!firstKeyword) {
    return normalized;
  }
  const normalizedKeyword = firstKeyword.toLowerCase();
  if (normalizedKeyword === "explain") {
    return normalized;
  }
  if (normalizedKeyword !== "select" && normalizedKeyword !== "with") {
    return normalized;
  }
  if (/\blimit\b/.test(cleaned) || /\bfetch\s+first\b/.test(cleaned)) {
    return normalized;
  }
  return `${normalized} LIMIT ${QUERY_ROW_LIMIT}`;
}

function inferColumnType(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "unknown";
  }
  if (typeof value === "bigint") {
    return "int8";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int4" : "numeric";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "string") {
    return "text";
  }
  if (value instanceof Date) {
    return "timestamptz";
  }
  if (Buffer.isBuffer(value)) {
    return "bytea";
  }
  const tag = (value as { constructor?: { name?: string } }).constructor?.name;
  if (tag === "Decimal") {
    return "numeric";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return "jsonb";
}

function serializeCell(value: unknown): unknown {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  const tag = (value as { constructor?: { name?: string } }).constructor?.name;
  if (tag === "Decimal") {
    return value.toString();
  }
  return value;
}

function formatQueryError(err: unknown): ErrorResponse {
  const rawMessage =
    err instanceof Error && err.message ? err.message : "Query failed to execute.";
  const message = redactError(rawMessage);
  if (message.toLowerCase().includes("statement timeout")) {
    return makeError("ANALYZER_TIMEOUT", "Query timed out.", { reason: message });
  }
  return makeError("INVALID_INPUT", "Query failed to execute.", { reason: message });
}

function redactSqlForLlm(sql: string): string {
  const withoutComments = sql
    .replace(/--.*?$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const redactedStrings = withoutComments
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/"(?:\"\"|[^\"])*"/g, "\"?\"");
  const redactedNumbers = redactedStrings.replace(/\b\d+(?:\.\d+)?\b/g, "?");
  return redactedNumbers.trim();
}

function normalizeIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        return trimmed.slice(1, -1).replace(/""/g, "\"");
      }
      return trimmed;
    })
    .join(".");
}

function extractTableCandidates(sql: string): string[] {
  const withoutLineComments = sql.replace(/--.*?$/gm, " ");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, " ");
  const cleaned = withoutBlockComments.replace(/'(?:''|[^'])*'/g, "''");
  const candidates = new Set<string>();
  const pattern =
    /\b(from|join)\s+(?:lateral\s+)?((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\.(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    candidates.add(match[2]);
  }
  return Array.from(candidates);
}

function extractExplainJson(rows: unknown[]): unknown | null {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const first = rows[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const record = first as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return null;
  }
  return record[keys[0]] ?? null;
}

type PlanNode = Record<string, unknown>;
const MIS_ESTIMATION_RATIO = 10;

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readInt(value: unknown): number | null {
  const parsed = readNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.max(0, Math.round(parsed));
}

function readNodeType(node: PlanNode): string | null {
  const raw = node["Node Type"] ?? node["Operation"];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function isPlanNode(node: PlanNode): boolean {
  return (
    typeof node["Node Type"] === "string" ||
    typeof node["Operation"] === "string" ||
    Array.isArray(node["Plans"])
  );
}

function extractPlanRoots(explainJson: unknown): PlanNode[] {
  if (Array.isArray(explainJson)) {
    const roots: PlanNode[] = [];
    for (const entry of explainJson) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as PlanNode;
      const plan = record["Plan"];
      if (plan && typeof plan === "object" && !Array.isArray(plan)) {
        roots.push(plan as PlanNode);
      } else if (isPlanNode(record)) {
        roots.push(record);
      }
    }
    return roots;
  }

  if (explainJson && typeof explainJson === "object" && !Array.isArray(explainJson)) {
    const record = explainJson as PlanNode;
    const plan = record["Plan"];
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      return [plan as PlanNode];
    }
    if (isPlanNode(record)) {
      return [record];
    }
  }

  return [];
}

function parsePlanSummary(explainJson: unknown): PlanSummary {
  const roots = extractPlanRoots(explainJson);
  if (roots.length === 0) {
    throw new Error("EXPLAIN JSON missing Plan node");
  }

  const nodeTypes = new Set<string>();
  let hasSeqScan = false;
  let hasNestedLoop = false;
  let hasSort = false;
  let hasHashJoin = false;
  let hasBitmapHeapScan = false;
  let hasMisestimation = false;

  const visit = (node: PlanNode): void => {
    const nodeType = readNodeType(node);
    if (nodeType) {
      nodeTypes.add(nodeType);
      const normalized = nodeType.toLowerCase();
      if (normalized === "seq scan") {
        hasSeqScan = true;
      } else if (normalized === "nested loop") {
        hasNestedLoop = true;
      } else if (normalized === "sort") {
        hasSort = true;
      } else if (normalized === "hash join") {
        hasHashJoin = true;
      } else if (normalized === "bitmap heap scan") {
        hasBitmapHeapScan = true;
      }
    }

    if (!hasMisestimation) {
      const planRows = readInt(node["Plan Rows"]);
      const actualRows = readInt(node["Actual Rows"]);
      const loops = readInt(node["Actual Loops"]) ?? 1;
      const totalActualRows = actualRows !== null ? actualRows * Math.max(1, loops) : null;
      if (planRows !== null && totalActualRows !== null) {
        if (planRows === 0) {
          if (totalActualRows > 0) {
            hasMisestimation = true;
          }
        } else {
          const ratio = totalActualRows / planRows;
          if (ratio >= MIS_ESTIMATION_RATIO || ratio <= 1 / MIS_ESTIMATION_RATIO) {
            hasMisestimation = true;
          }
        }
      }
    }

    const children = node["Plans"];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          visit(child as PlanNode);
        }
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  const root = roots[0];
  const totalCost = readNumber(root["Total Cost"]);
  const planRows = readInt(root["Plan Rows"]);
  const actualRows = readInt(root["Actual Rows"]);
  const loops = readInt(root["Actual Loops"]) ?? 1;
  const totalActualRows = actualRows !== null ? actualRows * Math.max(1, loops) : null;

  return {
    totalCost,
    planRows,
    actualRows: totalActualRows,
    nodeTypes: Array.from(nodeTypes).sort(),
    hasSeqScan,
    hasNestedLoop,
    hasSort,
    hasHashJoin,
    hasBitmapHeapScan,
    hasMisestimation,
  };
}

async function collectAiMetadata(
  connectionString: string,
  sql: string
): Promise<{
  schema: { tables: Array<{ schema: string; name: string; type: "table" | "view"; columns: SchemaColumnResource[] }> };
  indexes: {
    tables: Array<{
      schema: string;
      name: string;
      primaryKey: string[];
      indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    }>;
  };
}> {
  const candidates = extractTableCandidates(sql);
  if (candidates.length === 0) {
    return { schema: { tables: [] }, indexes: { tables: [] } };
  }

  return runSchemaQuery(connectionString, async (tx) => {
    const resolved: Array<{ schema: string; name: string; type: "table" | "view" }> = [];
    const explicit: Array<{ schema: string; name: string }> = [];
    const names: string[] = [];

    for (const candidate of candidates) {
      const normalized = normalizeIdentifier(candidate);
      const parts = normalized.split(".").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 2) {
        explicit.push({ schema: parts[0], name: parts[1] });
      } else if (parts.length === 1) {
        names.push(parts[0]);
      }
    }

    for (const table of explicit) {
      const rows = await tx.$queryRaw<{ schema: string; name: string; type: string }[]>`
        SELECT table_schema AS schema, table_name AS name, table_type AS type
        FROM information_schema.tables
        WHERE table_schema = ${table.schema}
          AND table_name = ${table.name}
          AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      `;
      for (const row of rows) {
        resolved.push({
          schema: row.schema,
          name: row.name,
          type: row.type === "VIEW" ? "view" : "table",
        });
      }
    }

    if (names.length > 0) {
      const rows = await tx.$queryRaw<{ schema: string; name: string; type: string }[]>`
        SELECT table_schema AS schema, table_name AS name, table_type AS type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND table_name = ANY(${names})
      `;
      for (const row of rows) {
        resolved.push({
          schema: row.schema,
          name: row.name,
          type: row.type === "VIEW" ? "view" : "table",
        });
      }
    }

    const deduped = new Map<string, { schema: string; name: string; type: "table" | "view" }>();
    for (const table of resolved) {
      deduped.set(`${table.schema}.${table.name}`, table);
    }

    const schemaTables: Array<{
      schema: string;
      name: string;
      type: "table" | "view";
      columns: SchemaColumnResource[];
    }> = [];
    const indexTables: Array<{
      schema: string;
      name: string;
      primaryKey: string[];
      indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    }> = [];

    for (const table of deduped.values()) {
      const columns = await tx.$queryRaw<SchemaColumnResource[]>`
        SELECT
          column_name AS name,
          udt_name AS type,
          is_nullable = 'YES' AS nullable,
          column_default AS "default"
        FROM information_schema.columns
        WHERE table_schema = ${table.schema}
          AND table_name = ${table.name}
        ORDER BY ordinal_position
      `;

      schemaTables.push({
        schema: table.schema,
        name: table.name,
        type: table.type,
        columns,
      });

      const primaryKeyRows = await tx.$queryRaw<{ name: string }[]>`
        SELECT a.attname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary
          AND n.nspname = ${table.schema}
          AND c.relname = ${table.name}
        ORDER BY array_position(i.indkey::int2[], a.attnum)
      `;

      const indexRows = await tx.$queryRaw<
        Array<{ name: string; unique: boolean; columns: string[] }>
      >`
        SELECT
          idx.relname AS name,
          i.indisunique AS unique,
          array_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)) AS columns
        FROM pg_index i
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = tbl.relnamespace
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = ${table.schema}
          AND tbl.relname = ${table.name}
          AND NOT i.indisprimary
        GROUP BY idx.relname, i.indisunique
        ORDER BY idx.relname
      `;

      indexTables.push({
        schema: table.schema,
        name: table.name,
        primaryKey: primaryKeyRows.map((row) => row.name),
        indexes: indexRows.map((row) => ({
          name: row.name,
          columns: row.columns ?? [],
          unique: Boolean(row.unique),
        })),
      });
    }

    return { schema: { tables: schemaTables }, indexes: { tables: indexTables } };
  });
}

async function recordQueryExecution(params: {
  queryId: string;
  sql: string;
  source: string;
  executionTimeMs: number;
  rowsReturned: number;
  projectId: string | null;
  userId: string | null;
  orgId: string | null;
  client?: { extensionVersion?: string; vscodeVersion?: string };
}): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "query_executions"
        ("id", "sql", "source", "execution_time_ms", "rows_returned", "project_id", "user_id", "org_id", "client_extension_version", "client_vscode_version")
      VALUES
        (
          ${params.queryId}::uuid,
          ${params.sql},
          ${params.source},
          ${params.executionTimeMs},
          ${params.rowsReturned},
          ${params.projectId}::uuid,
          ${params.userId}::uuid,
          ${params.orgId}::uuid,
          ${params.client?.extensionVersion ?? null},
          ${params.client?.vscodeVersion ?? null}
        )
    `;
  } catch (err) {
    console.error("Failed to record query execution", err);
  }
}

async function callAnalyzer(
  sql: string,
  explainJson: Prisma.InputJsonValue,
  context: {
    projectId: string | null;
    userId: string | null;
    orgId: string | null;
    llmEnabled: boolean;
  }
): Promise<AnalyzerResultPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYZER_TIMEOUT_MS);

  try {
    const response = await fetch(`${analyzerBaseUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        sql,
        explain_json: explainJson,
        llm_enabled: context.llmEnabled,
        project_id: context.projectId,
        user_id: context.userId,
        org_id: context.orgId,
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | AnalyzerResultPayload
      | ErrorResponse
      | null;

    if (!response.ok) {
      if (payload && typeof (payload as ErrorResponse).code === "string") {
        throw {
          status: response.status,
          payload: payload as ErrorResponse,
        } satisfies AnalyzerError;
      }
      throw {
        status: 502,
        payload: makeError("ANALYZER_ERROR", "Analyzer service returned an unexpected response", {
          status: response.status,
        }),
      } satisfies AnalyzerError;
    }

    if (!payload || typeof payload !== "object" || !("analysis" in payload)) {
      throw {
        status: 502,
        payload: makeError("ANALYZER_ERROR", "Analyzer response malformed"),
      } satisfies AnalyzerError;
    }

    return payload as AnalyzerResultPayload;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && "payload" in err) {
      throw err as AnalyzerError;
    }

    if ((err as Error)?.name === "AbortError") {
      throw {
        status: 504,
        payload: makeError("ANALYZER_TIMEOUT", "Analysis timed out", {
          timeout_ms: ANALYZER_TIMEOUT_MS,
        }),
      } satisfies AnalyzerError;
    }

    throw {
      status: 502,
      payload: makeError("ANALYZER_ERROR", "Could not reach analyzer", {
        reason: err instanceof Error ? err.message : "unknown",
      }),
    } satisfies AnalyzerError;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateAnalysisResult(
  client: PrismaClient | Prisma.TransactionClient,
  analysisId: string,
  status: string,
  result: AnalysisResultValue
) {
  return client.analysis.update({
    where: { id: analysisId },
    data: { status, result },
  });
}

async function getRetentionCutoffForProject(
  prismaClient: PrismaClient,
  project: { orgId: string | null; ownerUserId: string | null }
) {
  const subject =
    project.orgId
      ? ({ subjectType: "ORG", orgId: project.orgId } as const)
      : project.ownerUserId
        ? ({ subjectType: "USER", userId: project.ownerUserId } as const)
        : null;

  if (!subject) {
    return null;
  }

  const planContext = await getPlanContext(prismaClient, subject);
  if (planContext.plan.historyRetentionDays <= 0) {
    return null;
  }

  const cutoffMs = planContext.plan.historyRetentionDays * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - cutoffMs);
}

async function listAnalysesByProject(
  prismaClient: PrismaClient,
  projectId: string,
  retentionCutoff: Date | null,
  limit = ANALYSIS_HISTORY_LIMIT
) {
  const clampedLimit = Math.min(Math.max(1, limit), 200);
  const where: Prisma.AnalysisWhereInput = {
    projectId,
    ...(retentionCutoff ? { createdAt: { gte: retentionCutoff } } : {}),
  };

  return prismaClient.analysis.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: clampedLimit,
  });
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; firstAttemptAt: number }>();

app.get("/health", (_req, res: Response<HealthResponse>) =>
  res.json({ ok: true, service: "api" })
);

function toUserResource(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

function parseRole(value?: string): OrgRole | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "OWNER") {
    return OrgRole.OWNER;
  }
  if (normalized === "ADMIN") {
    return OrgRole.ADMIN;
  }
  if (normalized === "MEMBER") {
    return OrgRole.MEMBER;
  }
  return null;
}

function registerLoginAttempt(key: string): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const existing = loginAttempts.get(key);
  if (!existing || now - existing.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now });
    return { limited: false };
  }

  existing.count += 1;
  if (existing.count > LOGIN_MAX_ATTEMPTS) {
    const retryAfterMs = existing.firstAttemptAt + LOGIN_WINDOW_MS - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { limited: true, retryAfter };
  }

  return { limited: false };
}

function clearLoginAttempts(key: string) {
  loginAttempts.delete(key);
}

async function fetchMembership(userId: string, orgId: string) {
  return prisma.orgMember.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
}

async function requireOrgRole(
  userId: string,
  orgId: string,
  roles: OrgRole[]
): Promise<boolean> {
  const membership = await fetchMembership(userId, orgId);
  if (!membership) {
    return false;
  }
  return roles.includes(membership.role);
}

async function resolveProjectContext(
  auth: NonNullable<AuthenticatedRequest["auth"]>,
  projectId: string | null | undefined
): Promise<ProjectContext> {
  let resolvedProjectId = projectId ?? null;

  if (auth.tokenProjectId) {
    if (resolvedProjectId && resolvedProjectId !== auth.tokenProjectId) {
      return {
        error: makeError("FORBIDDEN", "Token is restricted to a different project"),
        status: 403,
      };
    }
    resolvedProjectId = auth.tokenProjectId;
  }

  if (!resolvedProjectId) {
    return { projectId: null, orgId: auth.orgId };
  }

  const project = await prisma.project.findUnique({
    where: { id: resolvedProjectId },
    select: {
      id: true,
      name: true,
      orgId: true,
      ownerUserId: true,
      aiEnabled: true,
      organization: { select: { aiEnabled: true } },
    },
  });
  if (!project) {
    return { error: makeError("INVALID_INPUT", "Project not found"), status: 400 };
  }

  const projectRecord = {
    id: project.id,
    name: project.name,
    orgId: project.orgId,
    ownerUserId: project.ownerUserId,
    aiEnabled: project.aiEnabled,
    orgAiEnabled: project.organization?.aiEnabled ?? null,
  };

  if (project.ownerUserId) {
    if (!auth.userId || auth.userId !== project.ownerUserId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: null, project: projectRecord };
  }

  if (project.orgId) {
    if (auth.orgId && auth.orgId === project.orgId) {
      return { projectId: project.id, orgId: project.orgId, project: projectRecord };
    }
    if (!auth.userId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    const membership = await fetchMembership(auth.userId, project.orgId);
    if (!membership) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: project.orgId, project: projectRecord };
  }

  return { error: makeError("INVALID_INPUT", "Project ownership is invalid"), status: 400 };
}

app.post(
  "/api/v1/auth/signup",
  async (req: Request<unknown, unknown, { email?: string; password?: string; name?: string }>, res) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`email` and `password` are required"));
    }

    if (password.length < 8) {
      return res.status(400).json(makeError("INVALID_INPUT", "Password is too short"));
    }

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      const legacyPasswordMissing = existingUser.passwordHash.trim().length === 0;
      if (legacyPasswordMissing && process.env.NODE_ENV !== "production") {
        await ensureDefaultPlans(prisma);
        const passwordHash = await hashPassword(password);

        const { user: updatedUser, personalProject } = await prisma.$transaction(async (tx) => {
          const user = await tx.user.update({
            where: { id: existingUser.id },
            data: {
              passwordHash,
              name: existingUser.name ?? (name?.trim() || null),
            },
          });

          const project =
            (await tx.project.findFirst({
              where: { ownerUserId: existingUser.id },
              orderBy: { createdAt: "asc" },
            })) ??
            (await tx.project.create({
              data: { name: "Personal Project", ownerUserId: existingUser.id },
            }));

          const existingSubscription = await tx.subscription.findFirst({
            where: { subjectType: SubjectType.USER, userId: existingUser.id },
            orderBy: { createdAt: "desc" },
          });

          if (!existingSubscription) {
            const freePlan = await tx.plan.findUnique({ where: { code: "FREE" } });
            if (!freePlan) {
              throw new Error("FREE plan missing");
            }

            await tx.subscription.create({
              data: {
                planId: freePlan.id,
                subjectType: SubjectType.USER,
                userId: existingUser.id,
                orgId: null,
              },
            });
          }

          return { user, personalProject: project };
        });

        const session = await createSession(prisma, updatedUser.id);
        setSessionCookie(res, session.rawToken, session.expiresAt);

        return res.status(200).json({
          user: toUserResource(updatedUser),
          personal_project: {
            id: personalProject.id,
            name: personalProject.name,
          },
        });
      }

      return res.status(400).json(makeError("INVALID_INPUT", "Email already in use"));
    }

    const passwordHash = await hashPassword(password);

    await ensureDefaultPlans(prisma);
    const { user, personalProject } = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: normalizedEmail,
          name: name?.trim() || null,
          passwordHash,
        },
      });

      const createdProject = await tx.project.create({
        data: {
          name: "Personal Project",
          ownerUserId: createdUser.id,
        },
      });

      const freePlan = await tx.plan.findUnique({ where: { code: "FREE" } });
      if (!freePlan) {
        throw new Error("FREE plan missing");
      }

      await tx.subscription.create({
        data: {
          planId: freePlan.id,
          subjectType: SubjectType.USER,
          userId: createdUser.id,
          orgId: null,
        },
      });

      return { user: createdUser, personalProject: createdProject };
    });

    const session = await createSession(prisma, user.id);
    setSessionCookie(res, session.rawToken, session.expiresAt);

    return res.status(201).json({
      user: toUserResource(user),
      personal_project: {
        id: personalProject.id,
        name: personalProject.name,
      },
    });
  }
);

app.post(
  "/api/v1/auth/login",
  async (req: Request<unknown, unknown, { email?: string; password?: string }>, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`email` and `password` are required"));
    }

    const normalizedEmail = normalizeEmail(email);
    const rateKey = `${req.ip}:${normalizedEmail}`;
    const rate = registerLoginAttempt(rateKey);
    if (rate.limited) {
      if (rate.retryAfter) {
        res.setHeader("Retry-After", rate.retryAfter.toString());
      }
      return res.status(429).json(makeError("FORBIDDEN", "Too many login attempts"));
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Invalid credentials"));
    }

    if (user.passwordHash.trim().length === 0) {
      clearLoginAttempts(rateKey);
      return res.status(400).json(
        makeError(
          "INVALID_INPUT",
          "This account does not have a password set. Use signup to set a password (dev only)."
        )
      );
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Invalid credentials"));
    }

    clearLoginAttempts(rateKey);
    const session = await createSession(prisma, user.id);
    setSessionCookie(res, session.rawToken, session.expiresAt);

    return res.json({ user: toUserResource(user) });
  }
);

app.post("/api/v1/auth/logout", async (req: Request, res) => {
  const sessionToken = getSessionToken(req);
  if (sessionToken) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(sessionToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get("/api/v1/me", requireAuth(prisma), async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
  }

  const user = auth.userId
    ? await prisma.user.findUnique({ where: { id: auth.userId } })
    : null;
  const memberships = auth.userId
    ? await prisma.orgMember.findMany({
        where: { userId: auth.userId },
        include: { organization: true },
      })
    : [];
  const org = auth.orgId
    ? await prisma.organization.findUnique({ where: { id: auth.orgId } })
    : null;

  return res.json({
    user: user ? toUserResource(user) : null,
    org: org ? { id: org.id, name: org.name, ai_enabled: org.aiEnabled } : null,
    memberships: memberships.map((membership) => ({
      org_id: membership.orgId,
      org_name: membership.organization.name,
      role: membership.role,
    })),
  });
});

app.get("/api/v1/orgs", requireAuth(prisma), async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
  }

  if (auth.orgId && !auth.userId) {
    const org = await prisma.organization.findUnique({ where: { id: auth.orgId } });
    return res.json({
      orgs: org
        ? [{ id: org.id, name: org.name, role: OrgRole.MEMBER, ai_enabled: org.aiEnabled }]
        : [],
    });
  }

  if (!auth.userId) {
    return res.json({ orgs: [] });
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: auth.userId },
    include: { organization: true },
  });

  return res.json({
    orgs: memberships.map((membership) => ({
      id: membership.orgId,
      name: membership.organization.name,
      role: membership.role,
      ai_enabled: membership.organization.aiEnabled,
    })),
  });
});

app.post(
  "/api/v1/orgs",
  requireAuth(prisma),
  async (req: Request<unknown, unknown, { name?: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const userId = auth.userId;

    const name = req.body?.name?.trim();
    if (!name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` is required"));
    }

    await ensureDefaultPlans(prisma);
    const { org, membership } = await prisma.$transaction(async (tx) => {
      const createdOrg = await tx.organization.create({
        data: { name },
      });

      const createdMembership = await tx.orgMember.create({
        data: { orgId: createdOrg.id, userId, role: OrgRole.OWNER },
      });

      const freePlan = await tx.plan.findUnique({ where: { code: "FREE" } });
      if (!freePlan) {
        throw new Error("FREE plan missing");
      }

      await tx.subscription.create({
        data: {
          planId: freePlan.id,
          subjectType: SubjectType.ORG,
          orgId: createdOrg.id,
          userId: null,
        },
      });

      return { org: createdOrg, membership: createdMembership };
    });

    return res.status(201).json({
      org: { id: org.id, name: org.name, ai_enabled: org.aiEnabled },
      membership: { org_id: membership.orgId, role: membership.role },
    });
  }
);

app.patch(
  "/api/v1/orgs/:orgId",
  requireAuth(prisma),
  async (
    req: Request<{ orgId: string }, unknown, { name?: string; ai_enabled?: boolean }>,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const orgId = req.params.orgId;
    const name = req.body?.name?.trim();
    const aiEnabled = typeof req.body?.ai_enabled === "boolean" ? req.body.ai_enabled : null;
    if (!name && aiEnabled === null) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "Provide `name` or `ai_enabled`."));
    }
    if (typeof req.body?.name !== "undefined" && !name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` cannot be empty"));
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      return res.status(404).json(makeError("INVALID_INPUT", "Org not found"));
    }

    const allowed = await requireOrgRole(auth.userId, orgId, [OrgRole.OWNER, OrgRole.ADMIN]);
    if (!allowed) {
      return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
    }

    const updatePayload: Prisma.OrganizationUpdateInput = {};
    if (name) {
      updatePayload.name = name;
    }
    if (aiEnabled !== null) {
      updatePayload.aiEnabled = aiEnabled;
    }

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: updatePayload,
    });

    return res.json({ org: { id: updated.id, name: updated.name, ai_enabled: updated.aiEnabled } });
  }
);

app.post(
  "/api/v1/orgs/:orgId/invites",
  requireAuth(prisma),
  async (
    req: Request<{ orgId: string }, unknown, { email?: string; role?: string }>,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const orgId = req.params.orgId;
    const email = req.body?.email;
    const roleInput = req.body?.role;
    const parsedRole = parseRole(roleInput);
    if (roleInput && !parsedRole) {
      return res.status(400).json(makeError("INVALID_INPUT", "Invalid role"));
    }
    const role = parsedRole ?? OrgRole.MEMBER;
    if (!email) {
      return res.status(400).json(makeError("INVALID_INPUT", "`email` is required"));
    }

    const allowed = await requireOrgRole(auth.userId, orgId, [OrgRole.OWNER, OrgRole.ADMIN]);
    if (!allowed) {
      return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
    }

    const planContext = await getPlanContext(prisma, { subjectType: "ORG", orgId });
    const counts = await countOrgMembersAndPendingInvites(prisma, orgId);
    if (counts.total >= planContext.plan.maxMembersPerOrg) {
      return res
        .status(402)
        .json(
          makePlanLimitExceededError("Organization member quota exceeded for current plan.", {
            limit: planContext.plan.maxMembersPerOrg,
            used: counts.total,
            plan: planContext.planCode,
            suggested_plan: suggestedUpgradeForPlan(planContext.planCode),
          })
        );
    }

    const normalizedEmail = normalizeEmail(email);
    const rawToken = createOpaqueToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const existingInvite = await prisma.orgInvite.findFirst({
      where: { orgId, email: normalizedEmail, acceptedAt: null },
    });

    const invite = existingInvite
      ? await prisma.orgInvite.update({
          where: { id: existingInvite.id },
          data: { tokenHash, role, expiresAt },
        })
      : await prisma.orgInvite.create({
          data: {
            orgId,
            email: normalizedEmail,
            role,
            tokenHash,
            expiresAt,
          },
        });

    return res.status(201).json({
      invite: {
        id: invite.id,
        org_id: invite.orgId,
        email: invite.email,
        role: invite.role,
        expires_at: invite.expiresAt?.toISOString() ?? null,
      },
      token: rawToken,
    });
  }
);

app.post(
  "/api/v1/invites/accept",
  requireAuth(prisma),
  async (req: Request<unknown, unknown, { token?: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const token = req.body?.token?.trim();
    if (!token) {
      return res.status(400).json(makeError("INVALID_INPUT", "`token` is required"));
    }

    const invite = await prisma.orgInvite.findFirst({
      where: { tokenHash: hashToken(token), acceptedAt: null },
    });

    if (!invite) {
      return res.status(400).json(makeError("INVALID_INPUT", "Invite not found"));
    }

    if (invite.expiresAt && invite.expiresAt <= new Date()) {
      return res.status(400).json(makeError("INVALID_INPUT", "Invite expired"));
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId } });
    if (!user || normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
      return res.status(403).json(makeError("FORBIDDEN", "Invite email mismatch"));
    }

    const membership = await prisma.orgMember.upsert({
      where: { userId_orgId: { userId: auth.userId, orgId: invite.orgId } },
      update: { role: invite.role },
      create: { userId: auth.userId, orgId: invite.orgId, role: invite.role },
    });

    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedByUserId: auth.userId },
    });

    return res.json({
      org_id: membership.orgId,
      role: membership.role,
    });
  }
);

app.get("/api/v1/projects", requireAuth(prisma), async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
  }

  if (auth.tokenProjectId) {
    const project = await prisma.project.findUnique({ where: { id: auth.tokenProjectId } });
    if (!project) {
      return res.json({ projects: [] });
    }
    return res.json({
      projects: [
        {
          id: project.id,
          name: project.name,
          org_id: project.orgId ?? null,
          owner_user_id: project.ownerUserId ?? null,
        },
      ],
    });
  }

  if (auth.orgId && !auth.userId) {
    const projects = await prisma.project.findMany({
      where: { orgId: auth.orgId },
      orderBy: { createdAt: "desc" },
    });
    return res.json({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        org_id: project.orgId ?? null,
        owner_user_id: project.ownerUserId ?? null,
        ai_enabled: project.aiEnabled,
      })),
    });
  }

  if (!auth.userId) {
    return res.json({ projects: [] });
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: auth.userId },
    select: { orgId: true },
  });
  const orgIds = memberships.map((membership) => membership.orgId);
  const projects = await prisma.project.findMany({
    where: {
      OR: [{ ownerUserId: auth.userId }, { orgId: { in: orgIds } }],
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      org_id: project.orgId ?? null,
      owner_user_id: project.ownerUserId ?? null,
      ai_enabled: project.aiEnabled,
    })),
  });
});

app.post(
  "/api/v1/projects",
  requireAuth(prisma),
  async (
    req: Request<unknown, unknown, { name?: string; org_id?: string | null; ai_enabled?: boolean }>,
    res
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const name = req.body?.name?.trim();
    if (!name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` is required"));
    }

    const orgId = req.body?.org_id ?? null;
    const aiEnabled = typeof req.body?.ai_enabled === "boolean" ? req.body.ai_enabled : true;
    if (orgId) {
      const allowed = await requireOrgRole(auth.userId, orgId, [OrgRole.OWNER, OrgRole.ADMIN]);
      if (!allowed) {
        return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
      }
    }

    const subject = orgId
      ? ({ subjectType: "ORG", orgId } as const)
      : ({ subjectType: "USER", userId: auth.userId } as const);
    const planContext = await getPlanContext(prisma, subject);
    const usedProjects = await countProjectsForSubject(prisma, subject);
    if (usedProjects >= planContext.plan.maxProjects) {
      return res
        .status(402)
        .json(
          makePlanLimitExceededError("Project quota exceeded for current plan.", {
            limit: planContext.plan.maxProjects,
            used: usedProjects,
            plan: planContext.planCode,
            suggested_plan: suggestedUpgradeForPlan(planContext.planCode),
          })
        );
    }

    const project = await prisma.project.create({
      data: {
        name,
        orgId,
        ownerUserId: orgId ? null : auth.userId,
        aiEnabled,
      },
    });

    return res.status(201).json({
      project: {
        id: project.id,
        name: project.name,
        org_id: project.orgId ?? null,
        owner_user_id: project.ownerUserId ?? null,
        ai_enabled: project.aiEnabled,
      },
    });
  }
);

app.patch(
  "/api/v1/projects/:projectId",
  requireAuth(prisma),
  async (
    req: Request<{ projectId: string }, unknown, { name?: string; ai_enabled?: boolean }>,
    res
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const name = req.body?.name?.trim();
    const aiEnabled = typeof req.body?.ai_enabled === "boolean" ? req.body.ai_enabled : null;
    if (!name && aiEnabled === null) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "Provide `name` or `ai_enabled`."));
    }
    if (typeof req.body?.name !== "undefined" && !name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` cannot be empty"));
    }

    const projectContext = await resolveProjectContext(auth, req.params.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    if (!projectContext.project) {
      return res.status(400).json(makeError("INVALID_INPUT", "Project not found"));
    }

    if (projectContext.project.ownerUserId) {
      if (projectContext.project.ownerUserId !== auth.userId) {
        return res.status(403).json(makeError("FORBIDDEN", "Project access denied"));
      }
    } else if (projectContext.project.orgId) {
      const allowed = await requireOrgRole(auth.userId, projectContext.project.orgId, [
        OrgRole.OWNER,
        OrgRole.ADMIN,
      ]);
      if (!allowed) {
        return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
      }
    }

    const updatePayload: Prisma.ProjectUpdateInput = {};
    if (name) {
      updatePayload.name = name;
    }
    if (aiEnabled !== null) {
      updatePayload.aiEnabled = aiEnabled;
    }

    const updated = await prisma.project.update({
      where: { id: projectContext.project.id },
      data: updatePayload,
    });

    return res.json({
      project: {
        id: updated.id,
        name: updated.name,
        org_id: updated.orgId ?? null,
        owner_user_id: updated.ownerUserId ?? null,
        ai_enabled: updated.aiEnabled,
      },
    });
  }
);

app.delete(
  "/api/v1/projects/:projectId",
  requireAuth(prisma),
  async (req: Request<{ projectId: string }>, res) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const projectContext = await resolveProjectContext(auth, req.params.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    if (!projectContext.project) {
      return res.status(400).json(makeError("INVALID_INPUT", "Project not found"));
    }

    if (projectContext.project.ownerUserId) {
      if (projectContext.project.ownerUserId !== auth.userId) {
        return res.status(403).json(makeError("FORBIDDEN", "Project access denied"));
      }
    } else if (projectContext.project.orgId) {
      const allowed = await requireOrgRole(auth.userId, projectContext.project.orgId, [
        OrgRole.OWNER,
        OrgRole.ADMIN,
      ]);
      if (!allowed) {
        return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
      }
    }

    await prisma.project.delete({ where: { id: projectContext.project.id } });
    return res.json({ ok: true });
  }
);

app.get(
  "/api/v1/projects/:projectId/connections",
  requireAuth(prisma),
  async (req: Request<{ projectId: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const projectContext = await resolveProjectContext(auth, req.params.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    if (!projectContext.projectId) {
      return res.status(400).json(makeError("INVALID_INPUT", "Project not found"));
    }

    const records = await prisma.projectDbConnection.findMany({
      where: { projectId: projectContext.projectId },
      orderBy: { createdAt: "desc" },
    });

    try {
      const connections = records.map((record) =>
        mapConnectionResource(record, decryptCredentials(record.encryptedCredentials))
      );
      return res.json({ connections });
    } catch (err) {
      console.error("Failed to decrypt connections", err);
      return res
        .status(500)
        .json(makeError("ANALYZER_ERROR", "Failed to load connections"));
    }
  }
);

app.post(
  "/api/v1/projects/:projectId/connections",
  requireAuth(prisma),
  async (
    req: Request<
      { projectId: string },
      unknown,
      {
        name?: string;
        type?: string;
        host?: string;
        port?: number | string;
        database?: string;
        username?: string;
        password?: string;
        connection_url?: string;
        ssl_mode?: string;
      }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const projectContext = await resolveProjectContext(auth, req.params.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    if (!projectContext.projectId) {
      return res.status(400).json(makeError("INVALID_INPUT", "Project not found"));
    }

    const name = req.body?.name?.trim();
    if (!name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` is required"));
    }

    const type = req.body?.type?.trim().toLowerCase() ?? CONNECTION_TYPE_POSTGRES;
    if (type !== CONNECTION_TYPE_POSTGRES) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "Only postgres connections are supported"));
    }

    const sslMode = normalizeSslMode(req.body?.ssl_mode);
    if (!sslMode) {
      return res.status(400).json(makeError("INVALID_INPUT", "Invalid ssl_mode"));
    }

    const connectionUrl = req.body?.connection_url?.trim() || null;
    const host = req.body?.host?.trim() || null;
    const database = req.body?.database?.trim() || null;
    const username = req.body?.username?.trim() || null;
    const password = req.body?.password ? req.body.password : null;
    const portRaw = req.body?.port;
    let port = 5432;

    if (connectionUrl && host) {
      return res.status(400).json(
        makeError("INVALID_INPUT", "Provide either connection_url or host fields, not both")
      );
    }

    if (!connectionUrl && !host) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "Either connection_url or host is required"));
    }

    if (connectionUrl) {
      try {
        const parsed = new URL(connectionUrl);
        if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
          return res
            .status(400)
            .json(makeError("INVALID_INPUT", "connection_url must be postgres:// or postgresql://"));
        }
      } catch {
        return res
          .status(400)
          .json(makeError("INVALID_INPUT", "connection_url must be a valid URL"));
      }
    } else {
      if (!database) {
        return res.status(400).json(makeError("INVALID_INPUT", "`database` is required"));
      }
      if (!username) {
        return res.status(400).json(makeError("INVALID_INPUT", "`username` is required"));
      }
      if (typeof portRaw !== "undefined" && portRaw !== null && String(portRaw).trim()) {
        const parsedPort = Number(portRaw);
        if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
          return res.status(400).json(makeError("INVALID_INPUT", "Invalid port"));
        }
        port = parsedPort;
      }
    }

    let credentials: ConnectionCredentials;
    if (connectionUrl) {
      credentials = { url: connectionUrl };
    } else {
      if (!host) {
        return res.status(400).json(makeError("INVALID_INPUT", "`host` is required"));
      }
      if (!database) {
        return res.status(400).json(makeError("INVALID_INPUT", "`database` is required"));
      }
      if (!username) {
        return res.status(400).json(makeError("INVALID_INPUT", "`username` is required"));
      }
      credentials = {
        host,
        port,
        database,
        username,
        ...(password ? { password } : {}),
      };
    }

    let encryptedCredentials: Prisma.InputJsonValue;
    try {
      encryptedCredentials = encryptCredentials(credentials);
    } catch (err) {
      console.error("Failed to encrypt connection credentials", err);
      return res
        .status(500)
        .json(makeError("ANALYZER_ERROR", "Server encryption key is not configured"));
    }

    const created = await prisma.projectDbConnection.create({
      data: {
        projectId: projectContext.projectId,
        type,
        name,
        encryptedCredentials,
        sslMode,
      },
    });

    return res.status(201).json({
      connection: mapConnectionResource(created, credentials),
    });
  }
);

app.post(
  "/api/v1/connections/:connectionId/test",
  requireAuth(prisma),
  async (req: Request<{ connectionId: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const connection = await prisma.projectDbConnection.findUnique({
      where: { id: req.params.connectionId },
    });
    if (!connection) {
      return res.status(404).json(makeError("INVALID_INPUT", "Connection not found"));
    }

    const projectContext = await resolveProjectContext(auth, connection.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    let credentials: ConnectionCredentials;
    try {
      credentials = decryptCredentials(connection.encryptedCredentials);
    } catch (err) {
      console.error("Failed to decrypt connection credentials", err);
      return res
        .status(500)
        .json(makeError("ANALYZER_ERROR", "Failed to decrypt connection"));
    }

    const sslMode =
      normalizeSslMode(connection.sslMode) ?? DEFAULT_SSL_MODE;

    let connectionString: string;
    try {
      connectionString = buildConnectionString(credentials, sslMode);
    } catch (err) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "Connection credentials are incomplete"));
    }

    try {
      await testPostgresConnection(connectionString);
      clearSchemaCache(connection.id);
      return res.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : "Connection test failed";
      return res.status(400).json(
        makeError("INVALID_INPUT", "Connection test failed", {
          reason: sanitizeConnectionError(message),
        })
      );
    }
  }
);

app.get(
  "/api/v1/projects/:projectId/connections/:connectionId/schema/schemas",
  requireAuth(prisma),
  async (
    req: Request<
      { projectId: string; connectionId: string },
      unknown,
      unknown,
      { includeSystem?: string }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const connectionContext = await resolveProjectConnection(
      auth,
      req.params.projectId,
      req.params.connectionId
    );
    if ("error" in connectionContext) {
      return res.status(connectionContext.status).json(connectionContext.error);
    }

    const rateLimit = checkSchemaRateLimit({
      auth,
      projectId: connectionContext.projectId,
      connectionId: connectionContext.connection.id,
    });
    if (handleSchemaRateLimit(res, rateLimit)) {
      return;
    }

    const includeSystem = isTruthyParam(req.query.includeSystem);
    const cacheKey = schemaCacheKey(connectionContext.connection.id, "schemas", [
      includeSystem ? "system" : "user",
    ]);
    const cached = readSchemaCache<{ schemas: Array<{ name: string }> }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const schemas = await runSchemaQuery(connectionContext.connectionString, async (tx) => {
        if (includeSystem) {
          return tx.$queryRaw<{ name: string }[]>`
            SELECT n.nspname AS name
            FROM pg_namespace n
            WHERE n.nspname NOT LIKE 'pg_temp_%'
              AND n.nspname NOT LIKE 'pg_toast_temp_%'
            ORDER BY n.nspname
          `;
        }
        return tx.$queryRaw<{ name: string }[]>`
          SELECT n.nspname AS name
          FROM pg_namespace n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND n.nspname NOT LIKE 'pg_temp_%'
            AND n.nspname NOT LIKE 'pg_toast_temp_%'
          ORDER BY n.nspname
        `;
      });

      const response = { schemas: schemas.map((row) => ({ name: row.name })) };
      writeSchemaCache(cacheKey, response);
      return res.json(response);
    } catch (err) {
      console.error("Failed to fetch schemas", err);
      return res
        .status(500)
        .json(
          makeError(
            "SCHEMA_FETCH_FAILED",
            "Unable to fetch schemas. Check connection or permissions."
          )
        );
    }
  }
);

app.get(
  "/api/v1/projects/:projectId/connections/:connectionId/schema/tables",
  requireAuth(prisma),
  async (
    req: Request<
      { projectId: string; connectionId: string },
      unknown,
      unknown,
      { schema?: string }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const schemaName =
      typeof req.query.schema === "string" ? req.query.schema.trim() : "";
    if (!schemaName) {
      return res.status(400).json(makeError("INVALID_INPUT", "`schema` is required"));
    }

    const connectionContext = await resolveProjectConnection(
      auth,
      req.params.projectId,
      req.params.connectionId
    );
    if ("error" in connectionContext) {
      return res.status(connectionContext.status).json(connectionContext.error);
    }

    const rateLimit = checkSchemaRateLimit({
      auth,
      projectId: connectionContext.projectId,
      connectionId: connectionContext.connection.id,
    });
    if (handleSchemaRateLimit(res, rateLimit)) {
      return;
    }

    const cacheKey = schemaCacheKey(connectionContext.connection.id, "tables", [schemaName]);
    const cached = readSchemaCache<{
      schema: string;
      tables: SchemaTableResource[];
    }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const tables = await runSchemaQuery(connectionContext.connectionString, async (tx) => {
        return tx.$queryRaw<SchemaTableResource[]>`
          SELECT
            c.relname AS name,
            CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schemaName}
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          ORDER BY c.relname
        `;
      });

      const response = { schema: schemaName, tables };
      writeSchemaCache(cacheKey, response);
      return res.json(response);
    } catch (err) {
      console.error("Failed to fetch tables", err);
      return res
        .status(500)
        .json(
          makeError(
            "SCHEMA_FETCH_FAILED",
            "Unable to fetch tables. Check connection or permissions."
          )
        );
    }
  }
);

app.get(
  "/api/v1/projects/:projectId/connections/:connectionId/schema/columns",
  requireAuth(prisma),
  async (
    req: Request<
      { projectId: string; connectionId: string },
      unknown,
      unknown,
      { schema?: string; table?: string }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const schemaName =
      typeof req.query.schema === "string" ? req.query.schema.trim() : "";
    const tableName =
      typeof req.query.table === "string" ? req.query.table.trim() : "";
    if (!schemaName) {
      return res.status(400).json(makeError("INVALID_INPUT", "`schema` is required"));
    }
    if (!tableName) {
      return res.status(400).json(makeError("INVALID_INPUT", "`table` is required"));
    }

    const connectionContext = await resolveProjectConnection(
      auth,
      req.params.projectId,
      req.params.connectionId
    );
    if ("error" in connectionContext) {
      return res.status(connectionContext.status).json(connectionContext.error);
    }

    const rateLimit = checkSchemaRateLimit({
      auth,
      projectId: connectionContext.projectId,
      connectionId: connectionContext.connection.id,
    });
    if (handleSchemaRateLimit(res, rateLimit)) {
      return;
    }

    const cacheKey = schemaCacheKey(connectionContext.connection.id, "columns", [
      schemaName,
      tableName,
    ]);
    const cached = readSchemaCache<{
      schema: string;
      table: string;
      columns: SchemaColumnResource[];
    }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const columns = await runSchemaQuery(connectionContext.connectionString, async (tx) => {
        return tx.$queryRaw<SchemaColumnResource[]>`
          SELECT
            column_name AS name,
            udt_name AS type,
            is_nullable = 'YES' AS nullable,
            column_default AS "default"
          FROM information_schema.columns
          WHERE table_schema = ${schemaName}
            AND table_name = ${tableName}
          ORDER BY ordinal_position
        `;
      });

      const response = { schema: schemaName, table: tableName, columns };
      writeSchemaCache(cacheKey, response);
      return res.json(response);
    } catch (err) {
      console.error("Failed to fetch columns", err);
      return res
        .status(500)
        .json(
          makeError(
            "SCHEMA_FETCH_FAILED",
            "Unable to fetch columns. Check connection or permissions."
          )
        );
    }
  }
);

app.get(
  "/api/v1/projects/:projectId/connections/:connectionId/schema/table-meta",
  requireAuth(prisma),
  async (
    req: Request<
      { projectId: string; connectionId: string },
      unknown,
      unknown,
      { schema?: string; table?: string }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const schemaName =
      typeof req.query.schema === "string" ? req.query.schema.trim() : "";
    const tableName =
      typeof req.query.table === "string" ? req.query.table.trim() : "";
    if (!schemaName) {
      return res.status(400).json(makeError("INVALID_INPUT", "`schema` is required"));
    }
    if (!tableName) {
      return res.status(400).json(makeError("INVALID_INPUT", "`table` is required"));
    }

    const connectionContext = await resolveProjectConnection(
      auth,
      req.params.projectId,
      req.params.connectionId
    );
    if ("error" in connectionContext) {
      return res.status(connectionContext.status).json(connectionContext.error);
    }

    const rateLimit = checkSchemaRateLimit({
      auth,
      projectId: connectionContext.projectId,
      connectionId: connectionContext.connection.id,
    });
    if (handleSchemaRateLimit(res, rateLimit)) {
      return;
    }

    const cacheKey = schemaCacheKey(connectionContext.connection.id, "table-meta", [
      schemaName,
      tableName,
    ]);
    const cached = readSchemaCache<{
      schema: string;
      table: string;
      primaryKey: string[];
      indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const response = await runSchemaQuery(connectionContext.connectionString, async (tx) => {
        const primaryKeyRows = await tx.$queryRaw<{ name: string }[]>`
          SELECT a.attname AS name
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary
            AND n.nspname = ${schemaName}
            AND c.relname = ${tableName}
          ORDER BY array_position(i.indkey::int2[], a.attnum)
        `;

        const indexRows = await tx.$queryRaw<
          Array<{ name: string; unique: boolean; columns: string[] }>
        >`
          SELECT
            idx.relname AS name,
            i.indisunique AS unique,
            array_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)) AS columns
          FROM pg_index i
          JOIN pg_class tbl ON tbl.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = tbl.relnamespace
          JOIN pg_class idx ON idx.oid = i.indexrelid
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE n.nspname = ${schemaName}
            AND tbl.relname = ${tableName}
            AND NOT i.indisprimary
          GROUP BY idx.relname, i.indisunique
          ORDER BY idx.relname
        `;

        return {
          schema: schemaName,
          table: tableName,
          primaryKey: primaryKeyRows.map((row) => row.name),
          indexes: indexRows.map((row) => ({
            name: row.name,
            columns: row.columns ?? [],
            unique: Boolean(row.unique),
          })),
        };
      });

      writeSchemaCache(cacheKey, response);
      return res.json(response);
    } catch (err) {
      console.error("Failed to fetch table metadata", err);
      return res
        .status(500)
        .json(
          makeError(
            "SCHEMA_FETCH_FAILED",
            "Unable to fetch table metadata. Check connection or permissions."
          )
        );
    }
  }
);

app.delete(
  "/api/v1/connections/:connectionId",
  requireAuth(prisma),
  async (req: Request<{ connectionId: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const connection = await prisma.projectDbConnection.findUnique({
      where: { id: req.params.connectionId },
    });
    if (!connection) {
      return res.status(404).json(makeError("INVALID_INPUT", "Connection not found"));
    }

    const projectContext = await resolveProjectContext(auth, connection.projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    await prisma.projectDbConnection.delete({ where: { id: connection.id } });
    return res.json({ ok: true });
  }
);

app.post(
  "/api/v1/query/execute",
  requireAuth(prisma),
  async (req: Request<unknown, unknown, ExecuteQueryRequest>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const sql = req.body?.sql;
    if (!sql || typeof sql !== "string" || sql.trim().length === 0) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
    }
    const explainMode = normalizeExplainMode(req.body?.explain_mode);
    const meterStartedAt = Date.now();

    if (!isReadOnlySql(sql) || hasProhibitedClauses(sql)) {
      return res
        .status(400)
        .json(
          makeError(
            "SQL_NOT_READ_ONLY",
            "Only SELECT, WITH, or EXPLAIN statements are permitted"
          )
        );
    }

    const connectionId = req.body?.connectionId ?? null;
    const requestedProjectId = req.body?.projectId ?? null;
    let connectionContext:
      | {
          projectId: string;
          orgId: string | null;
          connection: {
            id: string;
            projectId: string;
            type: string;
            sslMode: string;
          };
          connectionString: string;
        }
      | null = null;

    if (connectionId) {
      if (!requestedProjectId) {
        return res
          .status(400)
          .json(makeError("INVALID_INPUT", "`projectId` is required"));
      }
      const resolved = await resolveProjectConnection(auth, requestedProjectId, connectionId);
      if ("error" in resolved) {
        return res.status(resolved.status ?? 400).json(resolved.error);
      }
      connectionContext = resolved;
    }

    const projectContext = connectionContext
      ? { projectId: connectionContext.projectId, orgId: connectionContext.orgId }
      : await resolveProjectContext(auth, requestedProjectId);

    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }
    if (!projectContext.projectId) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`projectId` is required"));
    }

    const normalizedSql = normalizeSql(sql);
    const queryId = randomUUID();
    const startedAt = Date.now();
    let columns: Array<{ name: string; type: string }> = [];
    let rows: Array<Array<unknown>> = [];
    let error: ErrorResponse | null = null;

    try {
      const querySql = applyRowLimit(normalizedSql);
      const rawRows = connectionContext
        ? await runConnectionQuery<unknown[]>(connectionContext.connectionString, querySql)
        : await queryPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
            return tx.$queryRawUnsafe(querySql);
          });

      if (Array.isArray(rawRows)) {
        const objectRows = rawRows.filter(
          (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object"
        );
        const sample = objectRows[0] ?? null;
        const columnNames = sample ? Object.keys(sample) : [];
        columns = columnNames.map((name) => ({
          name,
          type: sample ? inferColumnType(sample[name]) : "unknown",
        }));
        rows = objectRows.slice(0, QUERY_ROW_LIMIT).map((row) =>
          columnNames.map((name) => serializeCell(row[name]))
        );
      }
    } catch (err) {
      error = formatQueryError(err);
    }

    const executionTimeMs = Math.max(1, Date.now() - startedAt);
    const rowsReturned = rows.length;
    const source = req.body?.source ?? "vscode";
    const orgId = projectContext.orgId ?? auth.orgId ?? null;
    await recordQueryExecution({
      queryId,
      sql: normalizedSql,
      source,
      executionTimeMs,
      rowsReturned,
      projectId: projectContext.projectId ?? null,
      userId: auth.userId ?? null,
      orgId,
      ...(req.body?.client ? { client: req.body.client } : {}),
    });

    const response: ExecuteQueryResponse = {
      queryId,
      executionTimeMs,
      rowsReturned,
      columns,
      rows,
      error,
    };

    return res.json(response);
  }
);

app.post(
  "/analyze",
  requireAuth(prisma),
  async (
    req: Request<unknown, unknown, AnalyzeRequest>,
    res: Response<AnalyzeResponse | ErrorResponse>
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const body = req.body;
    const sql = body?.sql;
    if (!sql || typeof sql !== "string" || sql.trim().length === 0) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
    }
    if (!body?.projectId || typeof body.projectId !== "string") {
      return res.status(400).json(makeError("INVALID_INPUT", "`projectId` is required"));
    }
    if (!body?.connectionRef || typeof body.connectionRef !== "string") {
      return res.status(400).json(makeError("INVALID_INPUT", "`connectionRef` is required"));
    }
    if (!body?.sqlHash || typeof body.sqlHash !== "string") {
      return res.status(400).json(makeError("INVALID_INPUT", "`sqlHash` is required"));
    }

    if (!isReadOnlySql(sql) || hasProhibitedClauses(sql)) {
      return res
        .status(400)
        .json(
          makeError(
            "SQL_NOT_READ_ONLY",
            "Only SELECT, WITH, or EXPLAIN statements are permitted"
          )
        );
    }

    const firstKeyword = extractFirstKeyword(stripSqlCommentsAndLiterals(sql));
    if (firstKeyword && firstKeyword.toLowerCase() === "explain") {
      return res.status(400).json(
        makeError(
          "INVALID_INPUT",
          "Provide a SELECT or WITH statement. EXPLAIN is run server-side."
        )
      );
    }

    const explainMode = normalizeExplainMode(body.explainMode);
    if (explainMode === "EXPLAIN_ANALYZE" && body.allowAnalyze !== true) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "EXPLAIN ANALYZE is disabled for this request."));
    }

    const connectionContext = await resolveProjectConnection(
      auth,
      body.projectId,
      body.connectionRef
    );
    if ("error" in connectionContext) {
      return res.status(connectionContext.status).json(connectionContext.error);
    }

    const normalizedSql = normalizeSql(sql);
    const explainClause =
      explainMode === "EXPLAIN_ANALYZE"
        ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)"
        : "EXPLAIN (FORMAT JSON)";
    const meterStartedAt = Date.now();
    let explainJson: unknown | null = null;

    try {
      const explainRows = await runConnectionQuery<unknown[]>(
        connectionContext.connectionString,
        `${explainClause} ${normalizedSql}`
      );
      explainJson = extractExplainJson(explainRows);
    } catch (err) {
      const errorResponse = formatQueryError(err);
      const status = errorResponse.code === "ANALYZER_TIMEOUT" ? 504 : 400;
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: "query_analysis",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: errorResponse.code ?? "ANALYZER_ERROR",
        explainMode,
      });
      return res.status(status).json(errorResponse);
    }

    if (!explainJson) {
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: "query_analysis",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: "INVALID_EXPLAIN_JSON",
        explainMode,
      });
      return res
        .status(400)
        .json(makeError("INVALID_EXPLAIN_JSON", "EXPLAIN did not return JSON output"));
    }

    let planSummary: PlanSummary;
    try {
      planSummary = parsePlanSummary(explainJson);
    } catch (err) {
      const reason = redactError(err);
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: "query_analysis",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: "INVALID_EXPLAIN_JSON",
        explainMode,
      });
      return res
        .status(400)
        .json(makeError("INVALID_EXPLAIN_JSON", "Invalid EXPLAIN JSON output.", { reason }));
    }

    const eventId = await recordMeterEvent(prisma, {
      orgId: connectionContext.orgId ?? auth.orgId ?? null,
      projectId: connectionContext.projectId,
      userId: auth.userId ?? null,
      source: "vscode",
      eventType: "query_analysis",
      aiUsed: false,
      model: null,
      tokensEstimated: null,
      sql,
      durationMs: Date.now() - meterStartedAt,
      status: "success",
      errorCode: null,
      explainMode,
    });

    const response: AnalyzeResponse = {
      planSummary,
      findings: [],
      ai: [],
      confidence: "low",
      warnings: [],
      metering: {
        eventId,
        aiUsed: false,
        tokensEstimated: null,
      },
    };

    return res.json(response);
  }
);

app.post(
  "/api/v1/ai/sql/:action",
  requireAuth(prisma),
  async (
    req: Request<{ action: string }, unknown, AiSqlRequestBody>,
    res: Response<AiSqlResponse | ErrorResponse>
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const actionRaw =
      typeof req.params.action === "string" ? req.params.action.trim().toLowerCase() : "";
    if (!actionRaw || !isAiSqlAction(actionRaw)) {
      return res.status(400).json(makeError("INVALID_INPUT", "Unsupported AI action"));
    }
    const action = actionRaw as AiSqlAction;

    const sql = req.body?.sql;
    if (!sql || typeof sql !== "string" || sql.trim().length === 0) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
    }

    if (!isReadOnlySql(sql) || hasProhibitedClauses(sql)) {
      return res
        .status(400)
        .json(makeError("SQL_NOT_READ_ONLY", "Only SELECT or WITH statements are permitted"));
    }

    const firstKeyword = extractFirstKeyword(stripSqlCommentsAndLiterals(sql));
    if (firstKeyword && firstKeyword.toLowerCase() === "explain") {
      return res.status(400).json(
        makeError(
          "INVALID_INPUT",
          "Provide a SELECT or WITH statement. EXPLAIN is run server-side."
        )
      );
    }

    const projectId = req.body?.project_id ?? null;
    const connectionId = req.body?.connection_id ?? null;
    if (!projectId) {
      return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
    }
    if (!connectionId) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`connection_id` is required"));
    }

    const connectionContext = await resolveProjectConnection(auth, projectId, connectionId);
    if ("error" in connectionContext) {
      return res.status(connectionContext.status ?? 400).json(connectionContext.error);
    }

    const quotaSubject = connectionContext.orgId
      ? ({ subjectType: "ORG", orgId: connectionContext.orgId } as const)
      : auth.userId
        ? ({ subjectType: "USER", userId: auth.userId } as const)
        : auth.orgId
          ? ({ subjectType: "ORG", orgId: auth.orgId } as const)
          : null;

    if (!quotaSubject) {
      return res.status(403).json(makeError("FORBIDDEN", "Subject context required"));
    }

    const planContext = await getPlanContext(prisma, quotaSubject);
    const aiFeatureStatus = resolveAiFeatureStatusFromProject(connectionContext.project);
    const now = new Date();
    const llmAccess = aiFeatureStatus.enabled
      ? await resolveLlmAccess(prisma, quotaSubject, planContext.plan, now)
      : null;
    const llmEnabled = aiFeatureStatus.enabled && Boolean(llmAccess?.enabled);

    if (!llmEnabled) {
      const fallbackReason: AiSqlFallbackReason = aiFeatureStatus.enabled
        ? llmAccess?.reason ?? "plan_disabled"
        : aiFeatureStatus.reason ?? "project_disabled";
      const fallback = buildAiSqlFallbackResponse({
        reason: fallbackReason,
        planCode: planContext.planCode,
        used: llmAccess?.used ?? null,
        limit: llmAccess?.limit ?? null,
      });
      logAiSqlTelemetry({
        action,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        llmUsed: false,
        blocked: true,
        reason: fallbackReason,
        errorCode: null,
        provider: fallback.meta.provider,
        model: fallback.meta.model,
        latencyMs: fallback.meta.latency_ms,
      });
      return res.json(fallback);
    }

    const normalizedSql = normalizeSql(sql);
    const explainClause =
      explainMode === "EXPLAIN_ANALYZE"
        ? "EXPLAIN (ANALYZE, FORMAT JSON)"
        : "EXPLAIN (FORMAT JSON)";
    let explainJson: unknown | null = null;
    try {
      const explainRows = await runConnectionQuery<unknown[]>(
        connectionContext.connectionString,
        `${explainClause} ${normalizedSql}`
      );
      explainJson = extractExplainJson(explainRows);
    } catch (err) {
      const errorResponse = formatQueryError(err);
      const status = errorResponse.code === "ANALYZER_TIMEOUT" ? 504 : 400;
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: action === "explain" ? "ai_explain" : "ai_suggest",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: errorResponse.code ?? "ANALYZER_ERROR",
        explainMode,
      });
      return res.status(status).json(errorResponse);
    }

    if (!explainJson) {
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: action === "explain" ? "ai_explain" : "ai_suggest",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: "ANALYZER_ERROR",
        explainMode,
      });
      return res
        .status(502)
        .json(makeError("ANALYZER_ERROR", "EXPLAIN did not return JSON output"));
    }

    let metadata: Awaited<ReturnType<typeof collectAiMetadata>>;
    try {
      metadata = await collectAiMetadata(connectionContext.connectionString, normalizedSql);
    } catch (err) {
      console.error("Failed to collect AI metadata");
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: action === "explain" ? "ai_explain" : "ai_suggest",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: "SCHEMA_FETCH_FAILED",
        explainMode,
      });
      return res
        .status(500)
        .json(
          makeError(
            "SCHEMA_FETCH_FAILED",
            "Unable to fetch schema metadata. Check connection or permissions."
          )
        );
    }

    const userIntent =
      typeof req.body?.user_intent === "string" ? req.body.user_intent.trim() : null;
    const payload: AiSqlPayload = {
      sql_text: redactSqlForLlm(normalizedSql),
      schema: metadata.schema,
      indexes: metadata.indexes,
      explain_output: JSON.stringify(explainJson, null, 2),
      db_engine: "postgres",
      project_id: connectionContext.projectId,
      user_intent: userIntent && userIntent.length > 0 ? userIntent : null,
    };

    try {
      const response = await callAiSqlService(action, payload);
      const llmUsed =
        response.meta.provider !== "disabled" && response.meta.provider !== "mock";
      if (llmUsed) {
        await incrementLlmCallsThisMonth(prisma, quotaSubject, now);
      }
      logAiSqlTelemetry({
        action,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        llmUsed,
        blocked: false,
        reason: null,
        errorCode: null,
        provider: response.meta.provider,
        model: response.meta.model,
        latencyMs: response.meta.latency_ms,
      });
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: action === "explain" ? "ai_explain" : "ai_suggest",
        aiUsed: llmUsed,
        model: response.meta.model,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "success",
        errorCode: null,
        explainMode,
      });
      return res.json(response);
    } catch (err) {
      const aiErr = err as AiServiceError;
      if (aiErr?.payload) {
        if (aiErr.payload.code === "INVALID_INPUT") {
          void recordMeterEvent(prisma, {
            orgId: connectionContext.orgId ?? auth.orgId ?? null,
            projectId: connectionContext.projectId,
            userId: auth.userId ?? null,
            source: "vscode",
            eventType: action === "explain" ? "ai_explain" : "ai_suggest",
            aiUsed: false,
            model: null,
            tokensEstimated: null,
            sql,
            durationMs: Date.now() - meterStartedAt,
            status: "error",
            errorCode: aiErr.payload.code ?? "ANALYZER_ERROR",
            explainMode,
          });
          logAiSqlTelemetry({
            action,
            projectId: connectionContext.projectId,
            userId: auth.userId ?? null,
            orgId: connectionContext.orgId ?? auth.orgId ?? null,
            llmUsed: false,
            blocked: false,
            reason: null,
            errorCode: aiErr.payload.code,
          });
          return res.status(aiErr.status ?? 400).json(aiErr.payload);
        }

        const fallback = buildAiSqlFallbackResponse({ reason: "service_unavailable" });
        void recordMeterEvent(prisma, {
          orgId: connectionContext.orgId ?? auth.orgId ?? null,
          projectId: connectionContext.projectId,
          userId: auth.userId ?? null,
          source: "vscode",
          eventType: action === "explain" ? "ai_explain" : "ai_suggest",
          aiUsed: false,
          model: fallback.meta.model,
          tokensEstimated: null,
          sql,
          durationMs: Date.now() - meterStartedAt,
          status: "error",
          errorCode: aiErr.payload.code ?? "ANALYZER_ERROR",
          explainMode,
        });
        logAiSqlTelemetry({
          action,
          projectId: connectionContext.projectId,
          userId: auth.userId ?? null,
          orgId: connectionContext.orgId ?? auth.orgId ?? null,
          llmUsed: false,
          blocked: false,
          reason: "service_unavailable",
          errorCode: aiErr.payload.code ?? "ANALYZER_ERROR",
          provider: fallback.meta.provider,
          model: fallback.meta.model,
          latencyMs: fallback.meta.latency_ms,
        });
        return res.json(fallback);
      }

      const fallback = buildAiSqlFallbackResponse({ reason: "service_unavailable" });
      void recordMeterEvent(prisma, {
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: action === "explain" ? "ai_explain" : "ai_suggest",
        aiUsed: false,
        model: fallback.meta.model,
        tokensEstimated: null,
        sql,
        durationMs: Date.now() - meterStartedAt,
        status: "error",
        errorCode: "ANALYZER_ERROR",
        explainMode,
      });
      logAiSqlTelemetry({
        action,
        projectId: connectionContext.projectId,
        userId: auth.userId ?? null,
        orgId: connectionContext.orgId ?? auth.orgId ?? null,
        llmUsed: false,
        blocked: false,
        reason: "service_unavailable",
        errorCode: "ANALYZER_ERROR",
        provider: fallback.meta.provider,
        model: fallback.meta.model,
        latencyMs: fallback.meta.latency_ms,
      });
      return res.json(fallback);
    }
  }
);

app.get("/api/v1/tokens", requireAuth(prisma), async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
  }

  let tokens: Array<{
    id: string;
    label: string | null;
    subjectType: SubjectType;
    subjectId: string;
    projectId: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }> = [];

  if (auth.userId) {
    const memberships = await prisma.orgMember.findMany({
      where: { userId: auth.userId },
      select: { orgId: true, role: true },
    });
    const adminRoles: OrgRole[] = [OrgRole.OWNER, OrgRole.ADMIN];
    const adminOrgIds = memberships
      .filter((membership) => adminRoles.includes(membership.role))
      .map((membership) => membership.orgId);

    tokens = await prisma.apiToken.findMany({
      where: {
        OR: [
          { subjectType: SubjectType.USER, subjectId: auth.userId },
          adminOrgIds.length > 0
            ? { subjectType: SubjectType.ORG, subjectId: { in: adminOrgIds } }
            : undefined,
        ].filter(Boolean) as Prisma.ApiTokenWhereInput[],
      },
      orderBy: { createdAt: "desc" },
    });
  } else if (auth.orgId) {
    tokens = await prisma.apiToken.findMany({
      where: { subjectType: SubjectType.ORG, subjectId: auth.orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  return res.json({
    tokens: tokens.map((token) => ({
      id: token.id,
      label: token.label,
      subject_type: token.subjectType,
      subject_id: token.subjectId,
      project_id: token.projectId ?? null,
      created_at: token.createdAt.toISOString(),
      last_used_at: token.lastUsedAt?.toISOString() ?? null,
      revoked_at: token.revokedAt?.toISOString() ?? null,
    })),
  });
});

app.post(
  "/api/v1/tokens",
  requireAuth(prisma),
  async (
    req: Request<
      unknown,
      unknown,
      { label?: string; scope?: string; org_id?: string | null; project_id?: string | null }
    >,
    res: Response
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const scope = req.body?.scope?.trim().toLowerCase() ?? "user";
    const orgId = req.body?.org_id ?? null;
    const projectId = req.body?.project_id ?? null;

    let subjectType: SubjectType;
    let subjectId: string;

    if (scope === "org") {
      if (!orgId) {
        return res.status(400).json(makeError("INVALID_INPUT", "`org_id` is required"));
      }
      const allowed = await requireOrgRole(auth.userId, orgId, [OrgRole.OWNER, OrgRole.ADMIN]);
      if (!allowed) {
        return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
      }
      subjectType = SubjectType.ORG;
      subjectId = orgId;
    } else if (scope === "user") {
      subjectType = SubjectType.USER;
      subjectId = auth.userId;
    } else {
      return res.status(400).json(makeError("INVALID_INPUT", "Invalid scope"));
    }

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return res.status(400).json(makeError("INVALID_INPUT", "Project not found"));
      }
      if (subjectType === SubjectType.ORG && project.orgId !== subjectId) {
        return res.status(403).json(makeError("FORBIDDEN", "Project not in org scope"));
      }
      if (subjectType === SubjectType.USER) {
        const projectAccess = await resolveProjectContext(
          { ...auth, orgId: null, tokenProjectId: null, tokenId: null, sessionId: null, subjectType },
          projectId
        );
        if ("error" in projectAccess) {
          return res.status(projectAccess.status ?? 400).json(projectAccess.error);
        }
      }
    }

    const rawToken = createOpaqueToken();
    const tokenHash = hashToken(rawToken);

    const token = await prisma.apiToken.create({
      data: {
        tokenHash,
        label: req.body?.label?.trim() || null,
        subjectType,
        subjectId,
        projectId: projectId ?? null,
      },
    });

    return res.status(201).json({
      token: rawToken,
      token_id: token.id,
      subject_type: token.subjectType,
      subject_id: token.subjectId,
      project_id: token.projectId ?? null,
    });
  }
);

app.post(
  "/api/v1/tokens/:id/revoke",
  requireAuth(prisma),
  async (req: Request<{ id: string }>, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const token = await prisma.apiToken.findUnique({ where: { id: req.params.id } });
    if (!token) {
      return res.status(404).json(makeError("INVALID_INPUT", "Token not found"));
    }

    if (auth.userId) {
      if (token.subjectType === SubjectType.USER && token.subjectId === auth.userId) {
        await prisma.apiToken.update({
          where: { id: token.id },
          data: { revokedAt: new Date() },
        });
        return res.json({ ok: true });
      }

      if (token.subjectType === SubjectType.ORG) {
        const allowed = await requireOrgRole(auth.userId, token.subjectId, [
          OrgRole.OWNER,
          OrgRole.ADMIN,
        ]);
        if (!allowed) {
          return res.status(403).json(makeError("FORBIDDEN", "Insufficient org role"));
        }
        await prisma.apiToken.update({
          where: { id: token.id },
          data: { revokedAt: new Date() },
        });
        return res.json({ ok: true });
      }
    }

    if (auth.orgId && !auth.userId && token.subjectType === SubjectType.ORG) {
      if (token.subjectId !== auth.orgId) {
        return res.status(403).json(makeError("FORBIDDEN", "Token does not belong to org"));
      }
      await prisma.apiToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date() },
      });
      return res.json({ ok: true });
    }

    return res.status(403).json(makeError("FORBIDDEN", "Forbidden"));
  }
);

app.post(
  "/api/v1/analyses",
  requireAuth(prisma),
  async (
    req: Request<unknown, unknown, AnalysisCreateRequest>,
    res: Response<AnalysisCreateResponse | ErrorResponse>
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const body = req.body;
    if (!body || typeof body.sql !== "string" || body.sql.trim().length === 0) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
    }
    const explainMode = normalizeExplainMode(body.explain_mode);

    if (!isReadOnlySql(body.sql) || hasProhibitedClauses(body.sql)) {
      return res
        .status(400)
        .json(
          makeError(
            "SQL_NOT_READ_ONLY",
            "Only SELECT, WITH, or EXPLAIN statements are permitted"
          )
        );
    }

    if (typeof body.explain_json === "undefined") {
      return res
        .status(400)
        .json(
          makeError(
            "INVALID_EXPLAIN_JSON",
            "`explain_json` must be provided as object or array"
          )
        );
    }

    let explainJsonParsed: unknown;
    let explainSerialized: string;
    try {
      explainSerialized = JSON.stringify(body.explain_json);
      explainJsonParsed = JSON.parse(explainSerialized);
    } catch (err) {
      return res
        .status(400)
        .json(
          makeError(
            "INVALID_EXPLAIN_JSON",
            "Invalid JSON for `explain_json`",
            err instanceof Error ? { reason: err.message } : undefined
          )
        );
    }

    const projectContext = await resolveProjectContext(auth, body.project_id);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    const quotaSubject = projectContext.orgId
      ? ({ subjectType: "ORG", orgId: projectContext.orgId } as const)
      : auth.userId
        ? ({ subjectType: "USER", userId: auth.userId } as const)
        : auth.orgId
          ? ({ subjectType: "ORG", orgId: auth.orgId } as const)
          : null;

    if (!quotaSubject) {
      return res.status(403).json(makeError("FORBIDDEN", "Subject context required"));
    }

    const planContext = await getPlanContext(prisma, quotaSubject);
    const now = new Date();
    const aiFeatureStatus = await resolveAiFeatureStatusForContext(prisma, projectContext);
    let llmEnabled = false;
    if (aiFeatureStatus.enabled) {
      const llmAccess = await resolveLlmAccess(prisma, quotaSubject, planContext.plan, now);
      llmEnabled = llmAccess.enabled;
    }

    const sizeError = checkSqlAndExplainSizeLimits(
      planContext.plan,
      planContext.planCode,
      body.sql,
      explainSerialized
    );
    if (sizeError) {
      logAnalysisTelemetry({
        analysisId: null,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        analyzerDurationMs: null,
        analyzerErrorCode: sizeError.code,
        quotaDenied: true,
        rateLimited: false,
        llmUsed: false,
      });
      return res.status(402).json(sizeError);
    }

    const usedThisMonth = await getAnalysesUsedThisMonth(prisma, quotaSubject, now);
    if (usedThisMonth >= planContext.plan.analysesPerMonth) {
      logAnalysisTelemetry({
        analysisId: null,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        analyzerDurationMs: null,
        analyzerErrorCode: "PLAN_LIMIT_EXCEEDED",
        quotaDenied: true,
        rateLimited: false,
        llmUsed: false,
      });
      return res
        .status(402)
        .json(
          makePlanLimitExceededError("Analysis quota exceeded for current period.", {
            limit: planContext.plan.analysesPerMonth,
            used: usedThisMonth,
            plan: planContext.planCode,
            suggested_plan: suggestedUpgradeForPlan(planContext.planCode),
          })
        );
    }

    const analysis = await prisma.$transaction(async (tx) => {
      const created = await tx.analysis.create({
        data: {
          sql: body.sql,
          explainJson: explainJsonParsed as Prisma.InputJsonValue,
          projectId: projectContext.projectId ?? null,
          userId: auth.userId ?? null,
          orgId: projectContext.orgId ?? null,
          status: "queued",
        },
      });

      await incrementAnalysesThisMonth(tx, quotaSubject, now);
      return created;
    });

    let analyzerStartedAt: number | null = null;
    try {
      analyzerStartedAt = Date.now();
      const analyzerResponse = await callAnalyzer(body.sql, explainJsonParsed as Prisma.InputJsonValue, {
        projectId: projectContext.projectId,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        llmEnabled,
      });
      const analyzerDurationMs = analyzerStartedAt ? Date.now() - analyzerStartedAt : null;

      const resultValue = toJsonResult(analyzerResponse.analysis.result);
      const completed = await updateAnalysisResult(
        prisma,
        analysis.id,
        analyzerResponse.analysis.status ?? "completed",
        resultValue
      );

      const llmUsed =
        analyzerResponse.analysis.result &&
        typeof analyzerResponse.analysis.result === "object" &&
        "llm_used" in analyzerResponse.analysis.result
          ? Boolean((analyzerResponse.analysis.result as { llm_used?: unknown }).llm_used)
          : false;

      if (llmUsed) {
        await incrementLlmCallsThisMonth(prisma, quotaSubject, now);
      }

      logAnalysisTelemetry({
        analysisId: analysis.id,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        analyzerDurationMs,
        analyzerErrorCode: null,
        quotaDenied: false,
        rateLimited: false,
        llmUsed,
      });
      void recordMeterEvent(prisma, {
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: "query_analysis",
        aiUsed: llmUsed,
        model: null,
        tokensEstimated: null,
        sql: body.sql,
        durationMs: analyzerDurationMs ?? 0,
        status: "success",
        errorCode: null,
        explainMode,
      });

      return res.status(201).json({ analysis: mapAnalysisToResource(completed) });
    } catch (err) {
      const analyzerDurationMs = analyzerStartedAt ? Date.now() - analyzerStartedAt : null;
      const analyzerErr = (err as AnalyzerError) ?? null;
      const payload =
        analyzerErr?.payload ?? makeError("ANALYZER_ERROR", "Analyzer failed unexpectedly");
      const status = analyzerErr?.status ?? 502;

      await updateAnalysisResult(prisma, analysis.id, "error", toJsonResult(payload));
      logAnalysisTelemetry({
        analysisId: analysis.id,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        analyzerDurationMs,
        analyzerErrorCode: payload.code ?? "ANALYZER_ERROR",
        quotaDenied: false,
        rateLimited: false,
        llmUsed: false,
      });
      void recordMeterEvent(prisma, {
        orgId: projectContext.orgId ?? auth.orgId ?? null,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        source: "vscode",
        eventType: "query_analysis",
        aiUsed: false,
        model: null,
        tokensEstimated: null,
        sql: body.sql,
        durationMs: analyzerDurationMs ?? 0,
        status: "error",
        errorCode: payload.code ?? "ANALYZER_ERROR",
        explainMode,
      });
      return res.status(status).json(payload);
    }
  }
);

app.get(
  "/api/v1/analyses",
  requireAuth(prisma),
  async (
    req: Request<unknown, unknown, unknown, { project_id?: string; limit?: string }>,
    res: Response<AnalysisListResponse | ErrorResponse>
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const projectId = typeof req.query.project_id === "string" ? req.query.project_id : null;
    if (!projectId) {
      return res.status(400).json(makeError("INVALID_INPUT", "`project_id` is required"));
    }

    const projectContext = await resolveProjectContext(auth, projectId);
    if ("error" in projectContext) {
      return res.status(projectContext.status ?? 400).json(projectContext.error);
    }

    if (!projectContext.projectId || !projectContext.project) {
      return res.status(404).json(makeError("INVALID_INPUT", "Project not found"));
    }

    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : ANALYSIS_HISTORY_LIMIT;
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : ANALYSIS_HISTORY_LIMIT;
    const retentionCutoff = await getRetentionCutoffForProject(prisma, projectContext.project);

    const analyses = await listAnalysesByProject(
      prisma,
      projectContext.projectId,
      retentionCutoff,
      limit
    );

    return res.json({ analyses: analyses.map(mapAnalysisToResource) });
  }
);

app.get(
  "/api/v1/analyses/:id",
  requireAuth(prisma),
  async (
    req: Request<{ id: string }>,
    res: Response<AnalysisGetResponse | ErrorResponse>
  ) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
    }

    const analysis = await prisma.analysis.findUnique({
      where: { id: req.params.id },
    });

    if (!analysis) {
      return res.status(404).json(makeError("INVALID_INPUT", "Analysis not found"));
    }

    const retentionSubject = analysis.orgId
      ? ({ subjectType: "ORG", orgId: analysis.orgId } as const)
      : analysis.userId
        ? ({ subjectType: "USER", userId: analysis.userId } as const)
        : null;
    if (retentionSubject) {
      const planContext = await getPlanContext(prisma, retentionSubject);
      const retentionMs = planContext.plan.historyRetentionDays * 24 * 60 * 60 * 1000;
      if (retentionMs > 0 && analysis.createdAt.getTime() < Date.now() - retentionMs) {
        return res.status(404).json(makeError("INVALID_INPUT", "Analysis not found"));
      }
    }

    if (analysis.userId && auth.userId === analysis.userId) {
      return res.json({ analysis: mapAnalysisToResource(analysis) });
    }

    if (analysis.orgId) {
      if (auth.orgId && auth.orgId === analysis.orgId) {
        return res.json({ analysis: mapAnalysisToResource(analysis) });
      }
      if (auth.userId) {
        const membership = await fetchMembership(auth.userId, analysis.orgId);
        if (membership) {
          return res.json({ analysis: mapAnalysisToResource(analysis) });
        }
      }
    }

    return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
  }
);

// Centralized error handler to preserve standardized error contract
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res
      .status(500)
      .json(makeError("ANALYZER_ERROR", "Unexpected server error", { reason: err.message }));
  }
);

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
async function start() {
  await ensureDefaultPlans(prisma);
  app.listen(port, () => console.log(`api listening on :${port}`));
}

start().catch((err) => {
  console.error("Failed to start API", err);
  process.exitCode = 1;
});

