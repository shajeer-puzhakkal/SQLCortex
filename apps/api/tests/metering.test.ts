import { test } from "node:test";
import assert from "node:assert/strict";
import { recordMeterEvent } from "../src/metering";
import { hashSql, normalizeSql } from "../../../packages/shared/src";

test("recordMeterEvent stores hashed SQL and clamps duration", async () => {
  let created: { data: Record<string, unknown> } | null = null;
  const prisma = {
    meterEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created = { data };
        return { id: data.id };
      },
    },
  } as any;

  const sql = "SELECT * FROM users";
  const eventId = await recordMeterEvent(prisma, {
    orgId: "org-1",
    projectId: "project-1",
    userId: "user-1",
    source: "vscode",
    eventType: "query_analysis",
    aiUsed: false,
    model: null,
    tokensEstimated: null,
    sql,
    durationMs: -12.4,
    status: "success",
    errorCode: null,
    explainMode: "EXPLAIN",
  });

  assert.ok(eventId);
  assert.ok(created);
  assert.equal(created?.data.id, eventId);
  assert.equal(created?.data.sqlHash, hashSql(normalizeSql(sql)));
  assert.equal(created?.data.durationMs, 0);
  assert.equal(created?.data.eventType, "query_analysis");
});
