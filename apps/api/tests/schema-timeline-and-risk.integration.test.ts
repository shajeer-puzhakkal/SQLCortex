import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { MigrationRiskScoreResponse, SchemaTimelineResponse } from "../src/contracts";

test("schema timeline and migration risk scoring endpoints return expected data", async () => {
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
  prismaMock.$executeRawUnsafe = async () => 1;

  const now = new Date();
  const snapshotDayOne = new Date(now);
  snapshotDayOne.setUTCDate(snapshotDayOne.getUTCDate() - 1);
  const snapshotDayTwo = new Date(now);
  const changeDayOne = new Date(now);
  changeDayOne.setUTCDate(changeDayOne.getUTCDate() - 2);
  const changeDayTwo = new Date(now);
  changeDayTwo.setUTCDate(changeDayTwo.getUTCDate() - 1);

  prismaMock.$queryRawUnsafe = async (sql: string) => {
    if (sql.includes("COUNT(*)::int AS indexes_affected")) {
      return [{ indexes_affected: 3 }];
    }
    if (sql.includes('FROM "schema_changes"') && sql.includes('ORDER BY "detected_at" DESC')) {
      return [
        {
          change_type: "index_dropped",
          object_name: "public.orders.orders_created_at_idx",
          detected_at: changeDayTwo,
        },
        {
          change_type: "column_removed",
          object_name: "public.users.legacy_status",
          detected_at: changeDayOne,
        },
        {
          change_type: "table_added",
          object_name: "public.audit_logs",
          detected_at: changeDayOne,
        },
      ];
    }
    if (sql.includes('FROM "observability_snapshots"') && sql.includes("ORDER BY \"snapshot_time\" ASC")) {
      return [
        {
          snapshot_time: snapshotDayOne,
          metric_data: {
            tables: [
              {
                schema_name: "public",
                table_name: "users",
                rows_inserted: 100,
                rows_updated: 20,
                rows_deleted: 10,
              },
              {
                schema_name: "public",
                table_name: "orders",
                rows_inserted: 50,
                rows_updated: 5,
                rows_deleted: 2,
              },
            ],
          },
        },
        {
          snapshot_time: snapshotDayTwo,
          metric_data: {
            tables: [
              {
                schema_name: "public",
                table_name: "users",
                rows_inserted: 130,
                rows_updated: 40,
                rows_deleted: 12,
              },
              {
                schema_name: "public",
                table_name: "orders",
                rows_inserted: 70,
                rows_updated: 12,
                rows_deleted: 4,
              },
            ],
          },
        },
      ];
    }
    return [];
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
      if (sql.includes("SUM(n_live_tup)")) {
        return [{ total_live_rows: 2_500_000, largest_table_rows: 900_000 }];
      }
      if (sql.includes("state = 'active'")) {
        return [{ active_connections: 32 }];
      }
      if (sql.includes("wait_event_type = 'Lock'")) {
        return [{ max_lock_wait_seconds: 27.5 }];
      }
      return [];
    },
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  try {
    const timelineResponse = await fetch(
      `http://127.0.0.1:${port}/api/intelligence/schema/timeline?project_id=project-1&range=7d`,
      {
        headers: { Authorization: "Bearer token-123" },
      },
    );
    assert.equal(timelineResponse.status, 200);
    const timelinePayload = (await timelineResponse.json()) as SchemaTimelineResponse;
    assert.equal(timelinePayload.project_id, "project-1");
    assert.equal(timelinePayload.range, "7d");
    assert.equal(timelinePayload.points.length, 7);
    assert.equal(timelinePayload.schema_changes.length, 3);
    assert.equal(timelinePayload.index_changes.length, 1);
    assert.ok(timelinePayload.table_growth.length >= 2);
    assert.ok(timelinePayload.points.some((point) => point.table_growth_rows > 0));

    const riskResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/schema/migration-risk/score`, {
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
    assert.equal(riskResponse.status, 200);
    const riskPayload = (await riskResponse.json()) as MigrationRiskScoreResponse;
    assert.equal(riskPayload.project_id, "project-1");
    assert.equal(riskPayload.connection_id, "conn-1");
    assert.equal(riskPayload.lookback_days, 7);
    assert.equal(riskPayload.factors.table_size_rows, 2_500_000);
    assert.equal(riskPayload.factors.active_connections, 32);
    assert.equal(riskPayload.factors.indexes_affected, 3);
    assert.equal(riskPayload.factors.lock_duration_seconds, 27.5);
    assert.ok(riskPayload.risk_score > 0 && riskPayload.risk_score <= 10);
    assert.equal(riskPayload.risk_level, "high");
    assert.ok(riskPayload.recommendations.some((entry) => entry.includes("low traffic")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
