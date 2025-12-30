import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSqlAndExplainSizeLimits } from "../src/quota";
import { PLAN_DEFINITIONS } from "../src/plans";

test("checkSqlAndExplainSizeLimits passes when within limits", () => {
  const plan = PLAN_DEFINITIONS.FREE;
  const result = checkSqlAndExplainSizeLimits(plan, "FREE", "SELECT 1", "{}");
  assert.equal(result, null);
});

test("checkSqlAndExplainSizeLimits rejects SQL that is too long", () => {
  const plan = PLAN_DEFINITIONS.FREE;
  const sql = "x".repeat(plan.maxSqlLength + 1);
  const result = checkSqlAndExplainSizeLimits(plan, "FREE", sql, "{}");
  assert.ok(result);
  assert.equal(result?.code, "PLAN_LIMIT_EXCEEDED");
});

test("checkSqlAndExplainSizeLimits rejects large explain payloads", () => {
  const plan = PLAN_DEFINITIONS.FREE;
  const explain = "x".repeat(plan.maxExplainJsonBytes + 1);
  const result = checkSqlAndExplainSizeLimits(plan, "FREE", "SELECT 1", explain);
  assert.ok(result);
  assert.equal(result?.code, "PLAN_LIMIT_EXCEEDED");
});
