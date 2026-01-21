import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("GET /dashboard/usage aggregates events and value meter", async () => {
  process.env.NODE_ENV = "test";

  const { app, prisma } = await import("../src/index");
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

  const now = Date.now();
  prismaMock.meterEvent = {
    findMany: async () => [
      {
        timestamp: new Date(now),
        eventType: "query_analysis",
        aiUsed: true,
      },
      {
        timestamp: new Date(now - 24 * 60 * 60 * 1000),
        eventType: "ai_explain",
        aiUsed: false,
      },
    ],
  };

  prismaMock.aiValueDaily = {
    findMany: async () => [
      { estimatedMinutesSaved: 12, estimatedCostSavedUsd: 8 },
      { estimatedMinutesSaved: 6, estimatedCostSavedUsd: 2 },
    ],
  };

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  const response = await fetch(`http://127.0.0.1:${port}/dashboard/usage?range=7d`, {
    headers: { Authorization: "Bearer token-123" },
  });
  const payload = (await response.json()) as Record<string, unknown>;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(response.status, 200);
  assert.equal(payload.totalActions, 2);
  assert.equal(payload.aiActions, 1);
  assert.equal(payload.ruleActions, 1);
  assert.ok(Array.isArray(payload.timeline));
  assert.equal((payload.timeline as Array<unknown>).length, 7);
  assert.equal(
    (payload.valueMeter as { minutesSaved: number }).minutesSaved,
    18
  );
  assert.equal((payload.valueMeter as { costSavedUsd: number }).costSavedUsd, 10);
});
