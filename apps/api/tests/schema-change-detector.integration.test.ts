import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { SchemaSnapshotCaptureResponse } from "../src/contracts";

test("POST /api/intelligence/schema/snapshots/capture detects and stores schema changes", async () => {
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

  let latestSnapshot: { schema_hash: string; schema_json: unknown } | null = null;
  const persistedChanges: Array<{
    project_id: string;
    change_type: string;
    object_name: string;
    detected_at: Date;
  }> = [];

  prismaMock.$queryRawUnsafe = async (sql: string) => {
    if (sql.includes('FROM "schema_snapshots"')) {
      return latestSnapshot ? [latestSnapshot] : [];
    }
    return [];
  };

  prismaMock.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql.includes('INSERT INTO "schema_snapshots"')) {
      latestSnapshot = {
        schema_hash: String(values[2]),
        schema_json: values[3],
      };
      return 1;
    }

    if (sql.includes('INSERT INTO "schema_changes"')) {
      persistedChanges.push({
        project_id: String(values[0]),
        change_type: String(values[1]),
        object_name: String(values[2]),
        detected_at: values[3] as Date,
      });
      return 1;
    }

    return 1;
  };

  let captureRound = 0;
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
      if (sql.includes("FROM information_schema.tables")) {
        captureRound += 1;
        if (captureRound === 1) {
          return [{ schema_name: "public", table_name: "users" }];
        }
        return [
          { schema_name: "public", table_name: "orders" },
          { schema_name: "public", table_name: "users" },
        ];
      }

      if (sql.includes("FROM information_schema.columns")) {
        if (captureRound === 1) {
          return [
            {
              schema_name: "public",
              table_name: "users",
              column_name: "id",
              data_type: "uuid",
              is_nullable: "NO",
              column_default: "gen_random_uuid()",
              ordinal_position: 1,
            },
            {
              schema_name: "public",
              table_name: "users",
              column_name: "email",
              data_type: "text",
              is_nullable: "NO",
              column_default: null,
              ordinal_position: 2,
            },
          ];
        }
        return [
          {
            schema_name: "public",
            table_name: "orders",
            column_name: "id",
            data_type: "uuid",
            is_nullable: "NO",
            column_default: "gen_random_uuid()",
            ordinal_position: 1,
          },
          {
            schema_name: "public",
            table_name: "users",
            column_name: "id",
            data_type: "uuid",
            is_nullable: "NO",
            column_default: "gen_random_uuid()",
            ordinal_position: 1,
          },
        ];
      }

      if (sql.includes("FROM pg_index idx")) {
        if (captureRound === 1) {
          return [
            {
              schema_name: "public",
              table_name: "users",
              index_name: "users_email_idx",
              is_unique: false,
              index_definition: "CREATE INDEX users_email_idx ON public.users USING btree (email)",
            },
            {
              schema_name: "public",
              table_name: "users",
              index_name: "users_pkey",
              is_unique: true,
              index_definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
            },
          ];
        }
        return [
          {
            schema_name: "public",
            table_name: "orders",
            index_name: "orders_created_at_idx",
            is_unique: false,
            index_definition: "CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at)",
          },
          {
            schema_name: "public",
            table_name: "users",
            index_name: "users_pkey",
            is_unique: true,
            index_definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
          },
        ];
      }

      if (sql.includes("FROM information_schema.table_constraints tc")) {
        return [];
      }

      if (sql.includes("FROM pg_constraint con")) {
        return [];
      }

      return [];
    },
  });

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = (server.address() as { port: number }).port;

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/schema/snapshots/capture`, {
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

    const secondResponse = await fetch(`http://127.0.0.1:${port}/api/intelligence/schema/snapshots/capture`, {
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
    const secondPayload = (await secondResponse.json()) as SchemaSnapshotCaptureResponse;
    assert.match(secondPayload.schema_hash, /^[a-f0-9]{64}$/);

    assert.equal(persistedChanges.length, 5);
    assert.deepEqual(
      persistedChanges.map((entry) => `${entry.change_type}:${entry.object_name}`),
      [
        "table_added:public.orders",
        "column_added:public.orders.id",
        "column_removed:public.users.email",
        "index_created:public.orders.orders_created_at_idx",
        "index_dropped:public.users.users_email_idx",
      ],
    );
    assert.ok(persistedChanges.every((entry) => entry.project_id === "project-1"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
