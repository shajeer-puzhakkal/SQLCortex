import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryFeatures } from "../src/types";
import { defaultRiskPolicy, type RiskPolicy } from "../src/risk/policy";
import { evaluateRisk } from "../src/risk/engine";

function featureFixture(overrides: Partial<QueryFeatures>): QueryFeatures {
  return {
    statement_type: "SELECT",
    select_star: false,
    table_count: 1,
    join_count: 0,
    where_present: true,
    limit_present: true,
    order_by_present: false,
    group_by_present: false,
    cte_count: 0,
    subquery_depth: 0,
    has_cartesian_join_risk: false,
    where_columns: [],
    join_columns: [],
    uses_functions: [],
    has_aggregation: false,
    has_window_functions: false,
    ...overrides,
  };
}

function resolvePolicy(environment: RiskPolicy["environment"]): RiskPolicy {
  return { ...defaultRiskPolicy, environment };
}

test("flags DELETE without WHERE as dangerous", () => {
  const result = evaluateRisk(
    featureFixture({ statement_type: "DELETE", where_present: false, table_count: 1 }),
    "delete from users",
  );
  assert.equal(result.risk_level, "Dangerous");
  assert.equal(result.gate.can_execute, false);
  assert.equal(result.gate.requires_confirmation, true);
  assert.ok(result.reasons.some((reason) => reason.code === "DELETE_WITHOUT_WHERE"));
});

test("flags UPDATE without WHERE as dangerous", () => {
  const result = evaluateRisk(
    featureFixture({ statement_type: "UPDATE", where_present: false }),
    "UPDATE accounts SET status='x'",
  );
  assert.equal(result.risk_level, "Dangerous");
  assert.ok(result.reasons.some((reason) => reason.code === "UPDATE_WITHOUT_WHERE"));
});

test("flags SELECT * without LIMIT as warning", () => {
  const result = evaluateRisk(
    featureFixture({
      select_star: true,
      where_present: true,
      limit_present: false,
      table_count: 2,
    }),
    "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
  );
  assert.equal(result.risk_level, "Warning");
  assert.equal(result.gate.can_execute, true);
  assert.equal(result.gate.requires_confirmation, false);
  assert.ok(result.reasons.some((reason) => reason.code === "SELECT_STAR_NO_LIMIT"));
});

test("flags cartesian joins as warning", () => {
  const result = evaluateRisk(featureFixture({ has_cartesian_join_risk: true, join_count: 1 }), "SELECT * FROM a, b;");
  assert.equal(result.risk_level, "Warning");
  assert.ok(result.reasons.some((reason) => reason.code === "CARTESIAN_JOIN_RISK"));
});

test("flags ORDER BY without LIMIT as warning", () => {
  const result = evaluateRisk(
    featureFixture({
      order_by_present: true,
      limit_present: false,
      table_count: 2,
    }),
    "SELECT id FROM users ORDER BY created_at;",
  );
  assert.equal(result.risk_level, "Warning");
  assert.ok(result.reasons.some((reason) => reason.code === "ORDER_BY_NO_LIMIT"));
});

test("flags sensitive-table reads without WHERE as warning", () => {
  const result = evaluateRisk(
    featureFixture({
      where_present: false,
      tables: ["event_log"],
      table_count: 1,
    }),
    "SELECT * FROM event_log",
  );
  assert.equal(result.risk_level, "Warning");
  assert.ok(result.reasons.some((reason) => reason.code === "SENSITIVE_TABLE_NO_WHERE"));
});

test("blocks DROP TABLE in production policy", () => {
  const result = evaluateRisk(
    featureFixture({
      statement_type: "DDL",
      where_present: false,
      tables: ["users"],
    }),
    "DROP TABLE users;",
    resolvePolicy("prod"),
  );
  assert.equal(result.risk_level, "Dangerous");
  assert.equal(result.gate.can_execute, false);
  assert.ok(result.reasons.some((reason) => reason.code === "DROP_TABLE"));
});

test("blocks ALTER TABLE in production policy", () => {
  const result = evaluateRisk(
    featureFixture({
      statement_type: "DDL",
      where_present: false,
      tables: ["users"],
    }),
    "ALTER TABLE users ADD COLUMN age int;",
    resolvePolicy("prod"),
  );
  assert.equal(result.risk_level, "Dangerous");
  assert.ok(result.reasons.some((reason) => reason.code === "ALTER_TABLE"));
});

test("allows TRUNCATE in development policy", () => {
  const result = evaluateRisk(
    featureFixture({
      statement_type: "TRUNCATE",
      where_present: false,
      tables: ["sessions"],
      limit_present: false,
      select_star: true,
    }),
    "TRUNCATE TABLE sessions;",
    resolvePolicy("dev"),
  );
  assert.equal(result.risk_level, "Safe");
  assert.equal(result.gate.can_execute, true);
});
