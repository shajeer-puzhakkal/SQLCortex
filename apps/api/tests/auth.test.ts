import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { attachAuth, hashToken, requireAuth } from "../src/auth";

type PrismaMock = {
  apiToken: {
    findUnique: (args: { where: { tokenHash: string } }) => Promise<any>;
    update: (args: { where: { id: string }; data: { lastUsedAt: Date } }) => Promise<any>;
  };
  session: {
    findUnique: (args: { where: { tokenHash: string } }) => Promise<any>;
  };
};

function makeResponse() {
  const res: Partial<Response> & { statusCode?: number; payload?: unknown } = {};
  res.status = ((statusCode: number) => {
    res.statusCode = statusCode;
    return res as Response;
  }) as Response["status"];
  res.json = ((payload: unknown) => {
    res.payload = payload;
    return res as Response;
  }) as Response["json"];
  res.setHeader = (() => res as Response) as Response["setHeader"];
  return res as Response;
}

function makeNext() {
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  return { next, wasCalled: () => called };
}

test("attachAuth sets auth for bearer token", async () => {
  const rawToken = "token-123";
  const tokenHash = hashToken(rawToken);
  const prisma: PrismaMock = {
    apiToken: {
      findUnique: async ({ where }) =>
        where.tokenHash === tokenHash
          ? {
              id: "token-id",
              subjectType: "USER",
              subjectId: "user-id",
              projectId: null,
              revokedAt: null,
              lastUsedAt: new Date(),
            }
          : null,
      update: async () => null,
    },
    session: {
      findUnique: async () => null,
    },
  };

  const req = {
    headers: { authorization: `Bearer ${rawToken}` },
  } as Request;
  const res = makeResponse();
  const { next, wasCalled } = makeNext();

  const middleware = attachAuth(prisma as unknown as any);
  await middleware(req, res, next);

  assert.ok(wasCalled());
  assert.equal((req as any).auth?.userId, "user-id");
  assert.equal((req as any).auth?.tokenId, "token-id");
});

test("requireAuth blocks unauthenticated requests", async () => {
  const prisma: PrismaMock = {
    apiToken: {
      findUnique: async () => null,
      update: async () => null,
    },
    session: {
      findUnique: async () => null,
    },
  };

  const req = { headers: {} } as Request;
  const res = makeResponse();
  const { next, wasCalled } = makeNext();

  const middleware = requireAuth(prisma as unknown as any);
  await middleware(req, res, next);

  assert.equal(wasCalled(), false);
  assert.equal((res as any).statusCode, 401);
});

test("requireAuth accepts session cookie", async () => {
  const rawToken = "session-raw";
  const tokenHash = hashToken(rawToken);
  const prisma: PrismaMock = {
    apiToken: {
      findUnique: async () => null,
      update: async () => null,
    },
    session: {
      findUnique: async ({ where }) =>
        where.tokenHash === tokenHash
          ? {
              id: "session-id",
              userId: "user-id",
              revokedAt: null,
              expiresAt: new Date(Date.now() + 60_000),
            }
          : null,
    },
  };

  const req = { headers: { cookie: `sc_session=${rawToken}` } } as Request;
  const res = makeResponse();
  const { next, wasCalled } = makeNext();

  const middleware = requireAuth(prisma as unknown as any);
  await middleware(req, res, next);

  assert.ok(wasCalled());
  assert.equal((req as any).auth?.sessionId, "session-id");
});
