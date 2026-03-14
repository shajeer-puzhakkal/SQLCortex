import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { ObservabilityCollectResponse } from "../src/contracts";

test("POST /api/intelligence/observability/collect stores observability snapshots", async () => {
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
    snapshot_time: Date;
    metric_type: string;
    metric_data_json: string;
  }> = [];

  prismaMock.$executeRawUnsafe = async (_sql: string, ...values: unknown[]) => {
    persisted.push({
      project_id: String(values[0]),
      snapshot_time: values[1] as Date,
      metric_type: String(values[2]),
      metric_data_json: String(values[3]),
    });
    return 1;
  };

  let pgStatStatementsAvailable = true;
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
      if (sql.includes("FROM pg_stat_user_tables")) {
        return [
          {
            schema_name: "public",
            table_name: "users",
            seq_scan: 5,
            idx_scan: 95,
            rows_inserted: 12,
            rows_updated: 4,
            rows_deleted: 1,
          },
        ];
      }
      if (sql.includes("FROM pg_stat_user_indexes")) {
        return [
          {
            schema_name: "public",
            table_name: "users",
            index_name: "users_email_idx",
            idx_scan: 95,
            idx_tup_read: 200,
            idx_tup_fetch: 198,
          },
        ];
      }
      if (sql.includes("FROM pg_stat_statements")) {
        if (!pgStatStatementsAvailable) {
          throw new Error('relation "pg_stat_statements" does not exist');
        }
        return [
          {
            query_id: "101",
            calls: 10,
            total_exec_time_ms: 123.4,
            mean_exec_time_ms: 12.34,
            rows: 500,
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
    const firstResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/observability/collect`, {
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
    assert.equal(firstResponse.status, 200);
    const firstPayload = (await firstResponse.json()) as ObservabilityCollectResponse;
    assert.equal(firstPayload.project_id, "project-1");
    assert.equal(firstPayload.connection_id, "conn-1");
    assert.equal(firstPayload.inserted_count, 3);
    assert.equal(firstPayload.metrics.length, 3);
    const firstQueryStatsMetric = firstPayload.metrics.find((metric) => metric.metric_type === "query_stats");
    assert.ok(firstQueryStatsMetric);
    assert.equal(firstQueryStatsMetric?.unavailable ?? false, false);

    pgStatStatementsAvailable = false;
    const secondResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/observability/collect`, {
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
    assert.equal(secondResponse.status, 200);
    const secondPayload = (await secondResponse.json()) as ObservabilityCollectResponse;
    const secondQueryStatsMetric = secondPayload.metrics.find((metric) => metric.metric_type === "query_stats");
    assert.ok(secondQueryStatsMetric);
    assert.equal(secondQueryStatsMetric?.unavailable, true);

    assert.equal(persisted.length, 6);
    const tableSnapshot = persisted.find((entry) => entry.metric_type === "table_stats");
    assert.ok(tableSnapshot);
    const tableMetricJson = JSON.parse(tableSnapshot?.metric_data_json ?? "{}");
    assert.equal(tableMetricJson.source, "pg_stat_user_tables");
    assert.equal(tableMetricJson.totals.seq_scan, 5);
    assert.equal(tableMetricJson.totals.idx_scan, 95);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
