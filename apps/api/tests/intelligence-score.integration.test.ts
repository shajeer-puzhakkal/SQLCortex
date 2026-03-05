import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

test("POST /api/intelligence/score returns plan summary and blocks unsafe SQL", async () => {
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

  const explainJson = [
    {
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 120456,
        "Plan Rows": 12000,
        "Plan Width": 96,
        Plans: [
          { "Node Type": "Seq Scan" },
          { "Node Type": "Sort" },
          { "Node Type": "Hash Join" },
        ],
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
        aiEnabled: true,
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

  try {
    const successResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-123",
      },
      body: JSON.stringify({
        mode: "plan",
        sql: "SELECT * FROM users u JOIN accounts a ON a.user_id = u.id",
        project_id: "project-1",
        connection_id: "conn-1",
      }),
    });
    const successPayload = (await successResponse.json()) as Record<string, unknown>;

    assert.equal(successResponse.status, 200);
    assert.equal(successPayload.version, "v1");
    assert.equal(successPayload.cost_bucket, "Extreme");
    assert.ok(
      successPayload.plan_summary &&
        typeof successPayload.plan_summary === "object" &&
        (successPayload.plan_summary as Record<string, unknown>).has_seq_scan === true,
    );

    const blockedResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-123",
      },
      body: JSON.stringify({
        mode: "plan",
        sql: "DELETE FROM users",
        project_id: "project-1",
        connection_id: "conn-1",
      }),
    });
    const blockedPayload = (await blockedResponse.json()) as Record<string, unknown>;

    assert.equal(blockedResponse.status, 400);
    assert.equal(blockedPayload.code, "SQL_NOT_READ_ONLY");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
