import express, { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import { OrgRole, Prisma, PrismaClient } from "@prisma/client";
import {
  AnalysisCreateRequest,
  AnalysisCreateResponse,
  AnalysisGetResponse,
  AnalysisListResponse,
  ErrorResponse,
  HealthResponse,
  makeError,
  mapAnalysisToResource,
} from "./contracts";
import { ensureDefaultPlans, getPlanContext, suggestedUpgradeForPlan } from "./plans";
import {
  checkSqlAndExplainSizeLimits,
  countOrgMembersAndPendingInvites,
  countProjectsForSubject,
  getAnalysesUsedThisMonth,
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
import { logAnalysisTelemetry } from "./telemetry";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

const defaultAnalyzerPort = process.env.ANALYZER_PORT ?? 8000;
const analyzerBaseUrl =
  process.env.ANALYZER_BASE_URL ??
  process.env.ANALYZER_URL ??
  `http://analyzer:${defaultAnalyzerPort}`;
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
      project?: { id: string; orgId: string | null; ownerUserId: string | null; name: string };
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
  sql?: string;
  source?: string;
  client?: { extensionVersion?: string; vscodeVersion?: string };
};

type ExecuteQueryResponse = {
  queryId: string;
  executionTimeMs: number;
  rowsReturned: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<unknown>>;
  error: ErrorResponse | null;
};

type AnalysisResultValue = Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;

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

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json());
app.use(attachAuth(prisma));
app.use(createRateLimitMiddleware(prisma));

function isReadOnlySql(sql: string): boolean {
  const withoutLineComments = sql.replace(/--.*?$/gm, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  const normalized = withoutBlockComments.trim().toLowerCase();

  if (normalized.includes(";") && normalized.indexOf(";") < normalized.length - 1) {
    return false;
  }

  if (normalized.startsWith("select")) {
    return true;
  }

  if (normalized.startsWith("explain")) {
    let afterExplain = normalized.slice("explain".length).trim();
    if (afterExplain.startsWith("(")) {
      let depth = 0;
      for (let i = 0; i < afterExplain.length; i += 1) {
        const ch = afterExplain[i];
        if (ch === "(") {
          depth += 1;
        } else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            afterExplain = afterExplain.slice(i + 1).trim();
            break;
          }
        }
      }
    }
    return afterExplain.startsWith("select");
  }

  return false;
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function stripSqlCommentsAndLiterals(sql: string): string {
  const withoutLineComments = sql.replace(/--.*?$/gm, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutStrings = withoutBlockComments
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\"\"|[^\"])*"/g, "\"\"");
  return withoutStrings;
}

function hasProhibitedClauses(sql: string): boolean {
  const cleaned = stripSqlCommentsAndLiterals(sql).toLowerCase();
  return (
    /\binto\b/.test(cleaned) ||
    /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(cleaned)
  );
}

function applyRowLimit(sql: string): string {
  const normalized = normalizeSql(sql);
  if (!normalized.toLowerCase().startsWith("select")) {
    return normalized;
  }
  const cleaned = stripSqlCommentsAndLiterals(normalized).toLowerCase();
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
  const message =
    err instanceof Error && err.message ? err.message : "Query failed to execute.";
  if (message.toLowerCase().includes("statement timeout")) {
    return makeError("ANALYZER_TIMEOUT", "Query timed out.", { reason: message });
  }
  return makeError("INVALID_INPUT", "Query failed to execute.", { reason: message });
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
          ${params.queryId},
          ${params.sql},
          ${params.source},
          ${params.executionTimeMs},
          ${params.rowsReturned},
          ${params.projectId},
          ${params.userId},
          ${params.orgId},
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
    select: { id: true, name: true, orgId: true, ownerUserId: true },
  });
  if (!project) {
    return { error: makeError("INVALID_INPUT", "Project not found"), status: 400 };
  }

  if (project.ownerUserId) {
    if (!auth.userId || auth.userId !== project.ownerUserId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: null, project };
  }

  if (project.orgId) {
    if (auth.orgId && auth.orgId === project.orgId) {
      return { projectId: project.id, orgId: project.orgId, project };
    }
    if (!auth.userId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    const membership = await fetchMembership(auth.userId, project.orgId);
    if (!membership) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: project.orgId, project };
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
    org: org ? { id: org.id, name: org.name } : null,
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
        ? [{ id: org.id, name: org.name, role: OrgRole.MEMBER }]
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
      org: { id: org.id, name: org.name },
      membership: { org_id: membership.orgId, role: membership.role },
    });
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
    })),
  });
});

app.post(
  "/api/v1/projects",
  requireAuth(prisma),
  async (req: Request<unknown, unknown, { name?: string; org_id?: string | null }>, res) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.userId) {
      return res.status(403).json(makeError("FORBIDDEN", "User context required"));
    }

    const name = req.body?.name?.trim();
    if (!name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` is required"));
    }

    const orgId = req.body?.org_id ?? null;
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
      },
    });

    return res.status(201).json({
      project: {
        id: project.id,
        name: project.name,
        org_id: project.orgId ?? null,
        owner_user_id: project.ownerUserId ?? null,
      },
    });
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

    if (!isReadOnlySql(sql) || hasProhibitedClauses(sql)) {
      return res
        .status(400)
        .json(makeError("SQL_NOT_READ_ONLY", "Only SELECT or EXPLAIN SELECT are permitted"));
    }

    const projectContext = await resolveProjectContext(auth, req.body?.projectId ?? null);
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
      const rawRows = await queryPrisma.$transaction(async (tx) => {
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

    if (!isReadOnlySql(body.sql)) {
      return res
        .status(400)
        .json(makeError("SQL_NOT_READ_ONLY", "Only SELECT or EXPLAIN SELECT are permitted"));
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
    const llmEnabled = planContext.plan.llmEnabled;

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

    const now = new Date();
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
