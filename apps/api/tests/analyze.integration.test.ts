import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hashSql, normalizeSql } from "../../../packages/shared/src";

test("POST /analyze returns plan summary with mocked dependencies", async () => {
  process.env.NODE_ENV = "test";

  const { app, prisma, setApiOverrides, clearApiOverrides } = await import("../src/index");
  const prismaMock = prisma as any;

  prismaMock.apiToken = {
    findUnique: async ({ where }: { where: { tokenHash: string } }) =>
      where.tokenHash
        ? {
            id: "token-1",
            subjectType: "USER",
            subjectId: "user-1",
            projectId: null,
            revokedAt: null,
            lastUsedAt: new Date(),
          }
        : null,
    update: async () => null,
  };
  prismaMock.plan = { upsert: async () => ({}) };
  prismaMock.subscription = {
    findFirst: async () => ({ id: "sub-1", plan: { code: "PRO" } }),
  };
  prismaMock.orgEntitlement = {
    findFirst: async () => ({
      id: "ent-1",
      planId: "pro",
      orgId: null,
      userId: "user-1",
      proStartedAt: new Date(),
    }),
  };
  prismaMock.meterEvent = {
    create: async ({ data }: { data: { id: string } }) => ({ id: data.id }),
  };

  const explainJson = [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "users",
        "Plan Rows": 10,
        "Actual Rows": 10,
        "Actual Loops": 1,
      },
    },
  ];

  setApiOverrides({
    resolveProjectConnection: async () => ({
      projectId: "project-1",
      orgId: null,
      project: {
        id: "project-1",
        orgId: null,
        ownerUserId: "user-1",
        name: "Demo Project",
        aiEnabled: false,
        orgAiEnabled: null,
      },
      connection: {
        id: "conn-1",
        projectId: "project-1",
        type: "postgres",
        sslMode: "require",
      },
      connectionString: "postgres://example",
    }),
    runConnectionQuery: async () => [{ "QUERY PLAN": explainJson }],
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  const sql = "SELECT * FROM users";
  const response = await fetch(`http://127.0.0.1:${port}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
    },
    body: JSON.stringify({
      orgId: "org-1",
      projectId: "project-1",
      source: "vscode",
      explainMode: "EXPLAIN",
      allowAnalyze: false,
      sql,
      sqlHash: hashSql(normalizeSql(sql)),
      connectionRef: "conn-1",
      clientContext: { extensionVersion: "0.0.0", workspaceIdHash: "ws-1" },
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;

  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearApiOverrides();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.ok(payload.planSummary);
  assert.ok(Array.isArray(payload.findings));
  assert.equal((payload.metering as { aiUsed: boolean }).aiUsed, false);
  assert.ok((payload.metering as { eventId?: string }).eventId);
});
