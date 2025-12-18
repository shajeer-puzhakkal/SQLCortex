import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { makeError } from "./contracts";

type SubjectType = "USER" | "ORG";

export type AuthPrincipal = {
  userId: string | null;
  orgId: string | null;
  subjectType: SubjectType | null;
  tokenId: string | null;
  tokenProjectId: string | null;
  sessionId: string | null;
};

export type AuthenticatedRequest = Request & {
  auth?: AuthPrincipal | null;
};

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "sc_session";
const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS ?? 30);
const bcryptRounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
const SESSION_TTL_DAYS =
  Number.isFinite(sessionTtlDays) && sessionTtlDays > 0 ? sessionTtlDays : 30;
const BCRYPT_ROUNDS =
  Number.isFinite(bcryptRounds) && bcryptRounds > 0 ? bcryptRounds : 12;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function createOpaqueToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, BCRYPT_ROUNDS, (err: Error | null, hash: string) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(hash);
    });
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err: Error | null, result: boolean) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

function parseCookies(headerValue?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headerValue) {
    return result;
  }

  for (const part of headerValue.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const [rawName, ...rest] = trimmed.split("=");
    if (!rawName) {
      continue;
    }
    const value = rest.join("=");
    result[rawName] = decodeURIComponent(value);
  }
  return result;
}

function buildCookie(
  name: string,
  value: string,
  options: { expires?: Date; maxAge?: number } = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function getSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

export async function createSession(prisma: PrismaClient, userId: string) {
  const rawToken = createOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      tokenHash,
      userId,
      expiresAt,
    },
  });

  return { rawToken, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE_NAME, token, { expires: expiresAt }));
}

export function clearSessionCookie(res: Response) {
  res.setHeader(
    "Set-Cookie",
    buildCookie(SESSION_COOKIE_NAME, "", { maxAge: 0, expires: new Date(0) })
  );
}

async function resolveAuth(prisma: PrismaClient, req: Request): Promise<AuthPrincipal | null> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const rawToken = authHeader.slice("Bearer ".length).trim();
    if (rawToken.length > 0) {
      const tokenHash = hashToken(rawToken);
      const apiToken = await prisma.apiToken.findUnique({
        where: { tokenHash },
      });
      if (apiToken && !apiToken.revokedAt) {
        const now = new Date();
        const shouldUpdateLastUsed =
          !apiToken.lastUsedAt || now.getTime() - apiToken.lastUsedAt.getTime() > 60_000;
        if (shouldUpdateLastUsed) {
          await prisma.apiToken.update({
            where: { id: apiToken.id },
            data: { lastUsedAt: now },
          });
        }

        return {
          userId: apiToken.subjectType === "USER" ? apiToken.subjectId : null,
          orgId: apiToken.subjectType === "ORG" ? apiToken.subjectId : null,
          subjectType: apiToken.subjectType,
          tokenId: apiToken.id,
          tokenProjectId: apiToken.projectId ?? null,
          sessionId: null,
        };
      }
    }
  }

  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return null;
  }
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(sessionToken) },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return null;
  }

  return {
    userId: session.userId,
    orgId: null,
    subjectType: null,
    tokenId: null,
    tokenProjectId: null,
    sessionId: session.id,
  };
}

export function attachAuth(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    if (typeof request.auth === "undefined") {
      request.auth = await resolveAuth(prisma, req);
    }
    next();
  };
}

export function requireAuth(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    if (typeof request.auth === "undefined") {
      request.auth = await resolveAuth(prisma, req);
    }
    if (!request.auth) {
      res.status(401).json(makeError("UNAUTHORIZED", "Authentication required"));
      return;
    }
    next();
  };
}
