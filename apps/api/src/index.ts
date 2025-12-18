import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OrgRole, Prisma, PrismaClient } from "@prisma/client";
import {
  AnalysisCreateRequest,
  AnalysisCreateResponse,
  AnalysisGetResponse,
  ErrorResponse,
  HealthResponse,
  makeError,
  mapAnalysisToResource,
} from "./contracts";
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

dotenv.config();

const app = express();
const prisma = new PrismaClient();

const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const SubjectType = {
  USER: "USER",
  ORG: "ORG",
} as const;
type SubjectType = (typeof SubjectType)[keyof typeof SubjectType];

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json());
app.use(attachAuth(prisma));

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
) {
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
  });
  if (!project) {
    return { error: makeError("INVALID_INPUT", "Project not found"), status: 400 };
  }

  if (project.ownerUserId) {
    if (!auth.userId || auth.userId !== project.ownerUserId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: null };
  }

  if (project.orgId) {
    if (auth.orgId && auth.orgId === project.orgId) {
      return { projectId: project.id, orgId: project.orgId };
    }
    if (!auth.userId) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    const membership = await fetchMembership(auth.userId, project.orgId);
    if (!membership) {
      return { error: makeError("FORBIDDEN", "Project access denied"), status: 403 };
    }
    return { projectId: project.id, orgId: project.orgId };
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
      return res.status(400).json(makeError("INVALID_INPUT", "Email already in use"));
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: name?.trim() || null,
        passwordHash,
      },
    });

    const personalProject = await prisma.project.create({
      data: {
        name: "Personal Project",
        ownerUserId: user.id,
      },
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

    if (!user || !user.passwordHash) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Invalid credentials"));
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

    const name = req.body?.name?.trim();
    if (!name) {
      return res.status(400).json(makeError("INVALID_INPUT", "`name` is required"));
    }

    const org = await prisma.organization.create({
      data: { name },
    });

    const membership = await prisma.orgMember.create({
      data: { orgId: org.id, userId: auth.userId, role: OrgRole.OWNER },
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
    const adminOrgIds = memberships
      .filter((membership) => [OrgRole.OWNER, OrgRole.ADMIN].includes(membership.role))
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
          return res.status(projectAccess.status).json(projectAccess.error);
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
    try {
      const serialized = JSON.stringify(body.explain_json);
      explainJsonParsed = JSON.parse(serialized);
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
      return res.status(projectContext.status).json(projectContext.error);
    }

    const analysis = await prisma.analysis.create({
      data: {
        sql: body.sql,
        explainJson: explainJsonParsed as Prisma.InputJsonValue,
        projectId: projectContext.projectId ?? null,
        userId: auth.userId ?? null,
        orgId: projectContext.orgId ?? null,
        status: "queued",
        result: null,
      },
    });

    return res.status(201).json({ analysis: mapAnalysisToResource(analysis) });
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
app.listen(port, () => console.log(`api listening on :${port}`));
