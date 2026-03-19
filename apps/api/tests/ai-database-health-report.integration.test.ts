import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { DatabaseHealthReportGenerateResponse } from "../src/contracts";

test("POST /api/intelligence/health-report/generate builds and stores weekly report", async () => {
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

  const persisted: Array<{
    project_id: string;
    report_week_start: Date;
    generated_at: Date;
    health_score: number;
    report_json: string;
  }> = [];

  prismaMock.$queryRawUnsafe = async (sql: string) => {
    if (sql.includes('FROM "schema_changes"')) {
      return [
        {
          change_type: "column_removed",
          object_name: "public.orders.legacy_status",
          detected_at: new Date("2026-03-14T10:00:00.000Z"),
        },
        {
          change_type: "index_created",
          object_name: "public.orders.orders_created_at_idx",
          detected_at: new Date("2026-03-13T10:00:00.000Z"),
        },
      ];
    }
    if (sql.includes('FROM "observability_snapshots"')) {
      return [
        {
          metric_data: {
            totals: {
              index_usage_pct: 88,
            },
          },
        },
      ];
    }
    return [];
  };
  prismaMock.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql.includes('INSERT INTO "database_health_reports"')) {
      persisted.push({
        project_id: String(values[0]),
        report_week_start: values[1] as Date,
        generated_at: values[2] as Date,
        health_score: Number(values[3]),
        report_json: String(values[4]),
      });
      return 1;
    }
    return 1;
  };

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
    runConnectionQuery: async (_connectionString: string, sql: string) => {
      if (sql.includes("FROM pg_stat_user_indexes s")) {
        return [
          {
            schema_name: "public",
            table_name: "users",
            index_name: "users_last_login_idx",
            idx_scan: 0,
            stats_reset: "2025-01-01T00:00:00.000Z",
          },
        ];
      }
      if (sql.includes("FROM pg_stat_user_tables")) {
        return [
          {
            schema_name: "public",
            table_name: "orders",
            seq_scan: 420,
            idx_scan: 35,
          },
        ];
      }
      if (sql.includes("FROM pg_index idx")) {
        return [
          {
            schema_name: "public",
            table_name: "orders",
            index_name: "orders_created_at_idx",
            index_definition: "CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at)",
          },
        ];
      }
      if (sql.includes("WHERE query ILIKE '% where %'")) {
        return [
          {
            query_text: "SELECT id FROM public.orders WHERE customer_id = $1",
            calls: 180,
          },
        ];
      }
      if (sql.includes("ORDER BY mean_exec_time DESC")) {
        return [
          {
            query_id: "901",
            query_text: "SELECT * FROM public.orders WHERE customer_id = $1 ORDER BY created_at DESC",
            calls: 180,
            total_exec_time_ms: 37800,
            mean_exec_time_ms: 210,
          },
        ];
      }
      if (sql.includes("FROM pg_stat_activity")) {
        return [
          {
            waiting_sessions: 2,
            active_sessions: 20,
          },
        ];
      }
      return [];
    },
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/intelligence/health-report/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token-123",
      },
      body: JSON.stringify({
        project_id: "project-1",
        connection_id: "conn-1",
      }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as DatabaseHealthReportGenerateResponse;
    assert.equal(payload.project_id, "project-1");
    assert.equal(payload.connection_id, "conn-1");
    assert.equal(payload.inserted_count, 1);
    assert.ok(payload.health_score >= 0 && payload.health_score <= 100);
    assert.equal(payload.top_slow_queries.length, 1);
    assert.equal(payload.missing_indexes.length, 1);
    assert.equal(payload.unused_indexes.length, 1);
    assert.equal(payload.schema_risks.length, 2);
    assert.equal(payload.schema_risks[0]?.risk_level, "high");
    assert.ok(payload.ai_summary.toLowerCase().includes("weekly health"));

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.project_id, "project-1");
    assert.ok(persisted[0]?.report_week_start instanceof Date);
    assert.ok(persisted[0]?.generated_at instanceof Date);
    const storedReport = JSON.parse(persisted[0]?.report_json ?? "{}");
    assert.equal(storedReport.health_score, payload.health_score);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
