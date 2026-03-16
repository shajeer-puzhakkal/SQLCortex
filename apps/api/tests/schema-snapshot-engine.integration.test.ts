import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { SchemaSnapshotCaptureResponse } from "../src/contracts";

test("POST /api/intelligence/schema/snapshots/capture stores schema snapshot with stable hash", async () => {
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
    schema_hash: string;
    schema_json: string;
  }> = [];

  prismaMock.$executeRawUnsafe = async (_sql: string, ...values: unknown[]) => {
    persisted.push({
      project_id: String(values[0]),
      snapshot_time: values[1] as Date,
      schema_hash: String(values[2]),
      schema_json: String(values[3]),
    });
    return 1;
  };
  prismaMock.$queryRawUnsafe = async () => [];

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
        return [
          { schema_name: "public", table_name: "users" },
          { schema_name: "public", table_name: "orders" },
        ];
      }
      if (sql.includes("FROM information_schema.columns")) {
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
          {
            schema_name: "public",
            table_name: "orders",
            column_name: "user_id",
            data_type: "uuid",
            is_nullable: "NO",
            column_default: null,
            ordinal_position: 1,
          },
        ];
      }
      if (sql.includes("FROM pg_index idx")) {
        return [
          {
            schema_name: "public",
            table_name: "users",
            index_name: "users_pkey",
            is_unique: true,
            index_definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
          },
          {
            schema_name: "public",
            table_name: "orders",
            index_name: "orders_user_id_idx",
            is_unique: false,
            index_definition: "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)",
          },
        ];
      }
      if (sql.includes("FROM information_schema.table_constraints tc")) {
        return [
          {
            schema_name: "public",
            table_name: "users",
            constraint_name: "users_pkey",
            constraint_type: "PRIMARY KEY",
          },
          {
            schema_name: "public",
            table_name: "users",
            constraint_name: "users_email_key",
            constraint_type: "UNIQUE",
          },
          {
            schema_name: "public",
            table_name: "orders",
            constraint_name: "orders_user_id_fkey",
            constraint_type: "FOREIGN KEY",
          },
        ];
      }
      if (sql.includes("FROM pg_constraint con")) {
        return [
          {
            schema_name: "public",
            table_name: "orders",
            constraint_name: "orders_user_id_fkey",
            column_name: "user_id",
            foreign_schema_name: "public",
            foreign_table_name: "users",
            foreign_column_name: "id",
            ordinal_position: 1,
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
    const firstPayload = (await firstResponse.json()) as SchemaSnapshotCaptureResponse;
    assert.equal(firstPayload.project_id, "project-1");
    assert.equal(firstPayload.connection_id, "conn-1");
    assert.match(firstPayload.schema_hash, /^[a-f0-9]{64}$/);
    assert.equal(firstPayload.inserted_count, 1);
    assert.deepEqual(firstPayload.object_counts, {
      tables: 2,
      columns: 3,
      indexes: 2,
      constraints: 3,
      foreign_keys: 1,
    });

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/api/intelligence/schema/snapshots/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-123",
        },
        body: JSON.stringify({
          project_id: "project-1",
          connection_id: "conn-1",
        }),
      },
    );
    assert.equal(secondResponse.status, 200);
    const secondPayload = (await secondResponse.json()) as SchemaSnapshotCaptureResponse;
    assert.equal(secondPayload.schema_hash, firstPayload.schema_hash);

    assert.equal(persisted.length, 2);
    assert.equal(persisted[0]?.project_id, "project-1");
    assert.equal(persisted[0]?.schema_hash, firstPayload.schema_hash);
    const schemaJson = JSON.parse(persisted[0]?.schema_json ?? "{}");
    assert.equal(schemaJson.tables?.length, 2);
    assert.equal(schemaJson.columns?.length, 3);
    assert.equal(schemaJson.indexes?.length, 2);
    assert.equal(schemaJson.constraints?.length, 3);
    assert.equal(schemaJson.foreign_keys?.length, 1);
    assert.equal(schemaJson.foreign_keys?.[0]?.foreign_table_name, "users");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearApiOverrides();
  }
});
