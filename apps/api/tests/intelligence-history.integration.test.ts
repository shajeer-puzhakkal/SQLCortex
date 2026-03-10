import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type {
  IntelligenceHistoryResponse,
  IntelligenceTopRiskyResponse,
  IntelligenceTrendsResponse,
} from "../src/contracts";

test("intelligence history, top-risky, and trends endpoints return paginated data", async () => {
  process.env.NODE_ENV = "test";

  const { app, prisma, setApiOverrides, clearApiOverrides } = await import("../src/index");
  const prismaMock = prisma as any;

  prismaMock.apiToken = {
    findUnique: async () => ({
      id: "token-1",
      subjectType: "USER",
      subjectId: "user-1",
      projectId: null,
      revokedAt: null,
      lastUsedAt: new Date(),
    }),
    update: async () => null,
  };
  prismaMock.project = {
    findUnique: async () => ({
      id: "project-1",
      ownerUserId: "user-1",
      orgId: null,
    }),
  };
  prismaMock.orgMember = {
    findUnique: async () => null,
  };

  const events: Array<{
    id: string;
    project_id: string;
    user_id: string | null;
    query_fingerprint: string;
    score: number;
    risk_level: string;
    cost_bucket: string;
    complexity: string;
    mode: "fast" | "plan";
    reasons_json: unknown;
    created_at: Date;
  }> = [];

  prismaMock.$executeRawUnsafe = async (_sql: string, ...values: unknown[]) => {
    events.unshift({
      id: `event-${events.length + 1}`,
      project_id: String(values[0]),
      user_id: values[1] ? String(values[1]) : null,
      query_fingerprint: String(values[4]),
      score: Number(values[5]),
      risk_level: String(values[6]),
      cost_bucket: String(values[7]),
      complexity: String(values[8]),
      mode: String(values[9]) === "plan" ? "plan" : "fast",
      reasons_json: JSON.parse(String(values[10])),
      created_at: new Date(),
    });
    return 1;
  };
  prismaMock.$queryRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql.includes("COUNT(*)::int AS total")) {
      return [{ total: events.length }];
    }
    if (sql.includes('ORDER BY "created_at" DESC, "id" DESC')) {
      const limit = Number(values[1]);
      const offset = Number(values[2]);
      return events.slice(offset, offset + limit);
    }
    if (sql.includes('GROUP BY "query_fingerprint"')) {
      const first = events[0];
      if (!first) return [];
      return [
        {
          query_fingerprint: first.query_fingerprint,
          events_count: events.length,
          avg_score: first.score,
          min_score: first.score,
          last_seen_at: first.created_at,
          risk_level: first.risk_level,
          cost_bucket: first.cost_bucket,
        },
      ];
    }
    if (sql.includes("TO_CHAR(DATE_TRUNC('day'")) {
      const first = events[0];
      if (!first) return [];
      const day = first.created_at.toISOString().slice(0, 10);
      const dangerous = events.filter((event) => event.risk_level === "Dangerous").length;
      const warning = events.filter((event) => event.risk_level === "Warning").length;
      const safe = events.filter((event) => event.risk_level === "Safe").length;
      return [
        {
          day,
          events_count: events.length,
          avg_score: first.score,
          dangerous_count: dangerous,
          warning_count: warning,
          safe_count: safe,
        },
      ];
    }
    if (sql.includes('GROUP BY "risk_level"')) {
      const counts = new Map<string, number>();
      for (const event of events) {
        counts.set(event.risk_level, (counts.get(event.risk_level) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([risk_level, count]) => ({ risk_level, count }));
    }
    if (sql.includes('GROUP BY "cost_bucket"')) {
      const counts = new Map<string, number>();
      for (const event of events) {
        counts.set(event.cost_bucket, (counts.get(event.cost_bucket) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([cost_bucket, count]) => ({ cost_bucket, count }));
    }
    if (sql.includes('EXTRACT(DOW FROM "created_at"')) {
      if (events.length === 0) return [];
      return [{ day_of_week: 1, hour_of_day: 9, events: events.length }];
    }
    return [];
  };

  const explainJson = [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 1000, "Plan Rows": 1000 } }];
  setApiOverrides({
    resolveProjectConnection: async () => ({
      projectId: "project-1",
      orgId: null,
      project: {
        id: "project-1",
        orgId: null,
        ownerUserId: "user-1",
        name: "Test Project",
        aiEnabled: true,
        orgAiEnabled: null,
      },
      connection: { id: "conn-1", projectId: "project-1", type: "postgres", sslMode: "require" },
      connectionString: "postgres://example",
    }),
    runConnectionQuery: async () => [{ "QUERY PLAN": explainJson }],
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  try {
    const scoreResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-123",
      },
      body: JSON.stringify({
        mode: "plan",
        project_id: "project-1",
        connection_id: "conn-1",
        sql: "SELECT * FROM users",
      }),
    });
    assert.equal(scoreResponse.status, 200);
    assert.equal(events.length, 1);

    const historyResponse = await fetch(
      `http://127.0.0.1:${port}/api/intelligence/history?project_id=project-1&page=1&limit=10`,
      {
        headers: { Authorization: "Bearer token-123" },
      },
    );
    assert.equal(historyResponse.status, 200);
    const historyPayload = (await historyResponse.json()) as IntelligenceHistoryResponse;
    assert.equal(historyPayload.events.length, 1);
    assert.equal(historyPayload.page, 1);
    assert.equal(historyPayload.limit, 10);

    const topRiskyResponse = await fetch(
      `http://127.0.0.1:${port}/api/intelligence/top-risky?project_id=project-1&range=7d`,
      {
        headers: { Authorization: "Bearer token-123" },
      },
    );
    assert.equal(topRiskyResponse.status, 200);
    const topRiskyPayload = (await topRiskyResponse.json()) as IntelligenceTopRiskyResponse;
    assert.ok(Array.isArray(topRiskyPayload.items));

    const trendsResponse = await fetch(
      `http://127.0.0.1:${port}/api/intelligence/trends?project_id=project-1&range=7d`,
      {
        headers: { Authorization: "Bearer token-123" },
      },
    );
    assert.equal(trendsResponse.status, 200);
    const trendsPayload = (await trendsResponse.json()) as IntelligenceTrendsResponse;
    assert.ok(Array.isArray(trendsPayload.points));
    assert.ok(Array.isArray(trendsPayload.heatmap));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
