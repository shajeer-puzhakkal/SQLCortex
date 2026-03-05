import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeCost } from "../src/plan/normalizeCost";
import { parsePlan } from "../src/plan/parsePlan";

const fixtureDirectory = join(__dirname, "fixtures");

test("parsePlan extracts plan metrics and node signals", () => {
  const fixture = JSON.parse(
    readFileSync(join(fixtureDirectory, "explain_nested_plan.json"), "utf8"),
  ) as unknown;
  const parsed = parsePlan(fixture);

  assert.equal(parsed.total_cost, 24567.89);
  assert.equal(parsed.plan_rows, 1200);
  assert.equal(parsed.plan_width, 64);
  assert.equal(parsed.has_seq_scan, true);
  assert.equal(parsed.has_hash_join, true);
  assert.equal(parsed.has_sort, true);
  assert.equal(parsed.has_nested_loop, true);
  assert.deepEqual(parsed.node_summary[0], { node_type: "Seq Scan", count: 2 });
});

test("parsePlan supports QUERY PLAN wrapper payloads", () => {
  const fixture = JSON.parse(
    readFileSync(join(fixtureDirectory, "explain_nested_plan.json"), "utf8"),
  ) as unknown;
  const wrapped = { "QUERY PLAN": fixture };
  const parsed = parsePlan(wrapped);
  assert.equal(parsed.total_cost, 24567.89);
});

test("normalizeCost uses default thresholds including Extreme", () => {
  assert.equal(normalizeCost(null), "Unknown");
  assert.equal(normalizeCost(1000), "Low");
  assert.equal(normalizeCost(1001), "Medium");
  assert.equal(normalizeCost(10001), "High");
  assert.equal(normalizeCost(100001), "Extreme");
});

test("normalizeCost supports configurable thresholds", () => {
  assert.equal(
    normalizeCost(2600, {
      thresholds: {
        lowMax: 2000,
        mediumMax: 2500,
        highMax: 5000,
      },
    }),
    "High",
  );
});
