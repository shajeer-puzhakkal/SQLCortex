import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { IndexHealthAnalyzeResponse } from "../src/contracts";

test("POST /api/intelligence/index-health/analyze detects and stores index health findings", async () => {
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
  prismaMock.$queryRawUnsafe = async () => [];

  const persisted: Array<{
    project_id: string;
    index_name: string;
    status: string;
    recommendation: string;
  }> = [];
  let deleteCalls = 0;
  prismaMock.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql.includes('DELETE FROM "index_health"')) {
      deleteCalls += 1;
      return 1;
    }
    if (sql.includes('INSERT INTO "index_health"')) {
      persisted.push({
        project_id: String(values[0]),
        index_name: String(values[1]),
        status: String(values[2]),
        recommendation: String(values[3]),
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
          {
            schema_name: "public",
            table_name: "orders",
            index_name: "orders_tmp_idx",
            idx_scan: 0,
            stats_reset: new Date(),
          },
        ];
      }
      if (sql.includes("FROM pg_stat_user_tables")) {
        return [
          {
            schema_name: "public",
            table_name: "orders",
            seq_scan: 500,
            idx_scan: 25,
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
      if (sql.includes("FROM pg_stat_statements")) {
        return [
          {
            query_text: "SELECT id FROM public.orders WHERE customer_id = $1",
            calls: 200,
          },
          {
            query_text: "SELECT id FROM public.orders WHERE status = $1",
            calls: 20,
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
    const response = await fetch(`http://127.0.0.1:${port}/api/intelligence/index-health/analyze`, {
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
    const payload = (await response.json()) as IndexHealthAnalyzeResponse;
    assert.equal(payload.project_id, "project-1");
    assert.equal(payload.connection_id, "conn-1");
    assert.equal(payload.findings.length, 2);
    assert.equal(payload.inserted_count, 2);

    const unusedFinding = payload.findings.find((finding) => finding.status === "unused_index");
    assert.ok(unusedFinding);
    assert.equal(unusedFinding?.index_name, "public.users.users_last_login_idx");

    const missingFinding = payload.findings.find((finding) => finding.status === "missing_index");
    assert.ok(missingFinding);
    assert.equal(missingFinding?.index_name, "public.orders.customer_id");

    assert.equal(deleteCalls, 1);
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((entry) => entry.project_id === "project-1"));
    assert.deepEqual(
      persisted.map((entry) => `${entry.status}:${entry.index_name}`),
      [
        "missing_index:public.orders.customer_id",
        "unused_index:public.users.users_last_login_idx",
      ],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
