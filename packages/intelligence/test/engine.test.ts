import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateQueryFeatures } from "../src/score/engine";
import type { IntelligenceResult, QueryFeatures } from "../src/types";

const fixtureDirectory = join(__dirname, "fixtures");

const fixtures: Array<{
  name: string;
  features: QueryFeatures;
}> = [
  {
    name: "select_star",
    features: {
      statement_type: "SELECT",
      select_star: true,
      table_count: 1,
      join_count: 0,
      where_present: true,
      limit_present: false,
      order_by_present: false,
      group_by_present: false,
      cte_count: 0,
      subquery_depth: 0,
      has_cartesian_join_risk: false,
      where_columns: ["email"],
      join_columns: [],
      uses_functions: ["lower"],
      has_aggregation: false,
      has_window_functions: false,
    },
  },
  {
    name: "write_without_where",
    features: {
      statement_type: "UPDATE",
      select_star: false,
      table_count: 1,
      join_count: 0,
      where_present: false,
      limit_present: false,
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
    },
  },
  {
    name: "multi_join",
    features: {
      statement_type: "SELECT",
      select_star: false,
      table_count: 4,
      join_count: 3,
      where_present: true,
      limit_present: true,
      order_by_present: true,
      group_by_present: false,
      cte_count: 1,
      subquery_depth: 1,
      has_cartesian_join_risk: false,
      where_columns: ["org_id"],
      join_columns: ["account_id", "user_id", "plan_id"],
      uses_functions: [],
      has_aggregation: false,
      has_window_functions: false,
    },
  },
  {
    name: "deep_subquery",
    features: {
      statement_type: "SELECT",
      select_star: false,
      table_count: 2,
      join_count: 1,
      where_present: true,
      limit_present: false,
      order_by_present: false,
      group_by_present: false,
      cte_count: 2,
      subquery_depth: 2,
      has_cartesian_join_risk: false,
      where_columns: ["user_id"],
      join_columns: ["user_id"],
      uses_functions: [],
      has_aggregation: true,
      has_window_functions: false,
    },
  },
];

function readExpectedFixture(name: string): IntelligenceResult {
  return JSON.parse(
    readFileSync(join(fixtureDirectory, `${name}.expected.json`), "utf8"),
  ) as IntelligenceResult;
}

for (const fixture of fixtures) {
  test(`evaluateQueryFeatures matches golden fixture for ${fixture.name}`, () => {
    const sql = readFileSync(join(fixtureDirectory, `${fixture.name}.sql`), "utf8");
    const expected = readExpectedFixture(fixture.name);
    const actual = evaluateQueryFeatures(fixture.features);

    assert.ok(sql.trim().length > 0, "SQL fixture should remain non-empty");
    assert.deepEqual(actual, expected);
  });
}

test("custom rule overrides stay deterministic", () => {
  const selectStarFixture = fixtures.find((fixture) => fixture.name === "select_star");

  assert.ok(selectStarFixture, "select_star fixture should exist");

  const actual = evaluateQueryFeatures(selectStarFixture.features, {
    config: {
      rules: {
        SELECT_STAR: {
          delta: -5,
        },
      },
    },
  });

  assert.equal(actual.performance_score, 85);
  assert.equal(actual.reasons[0]?.delta, -5);
});
