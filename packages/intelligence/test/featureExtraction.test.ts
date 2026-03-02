import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractQueryFeatures } from "../src/extract/features";
import { isSqlParseError, parseSqlToAst } from "../src/parse/pgParser";

const fixtureDirectory = join(__dirname, "fixtures");

test("extractQueryFeatures captures core features from a CTE + window query", () => {
  const sql = readFileSync(join(fixtureDirectory, "feature_window_cte.sql"), "utf8");
  const features = extractQueryFeatures(sql);

  assert.equal(features.statement_type, "SELECT");
  assert.equal(features.select_star, true);
  assert.equal(features.where_present, true);
  assert.equal(features.limit_present, true);
  assert.equal(features.order_by_present, true);
  assert.equal(features.group_by_present, true);
  assert.equal(features.cte_count, 1);
  assert.equal(features.join_count, 1);
  assert.equal(features.subquery_depth, 1);
  assert.equal(features.has_aggregation, true);
  assert.equal(features.has_window_functions, true);
  assert.equal(features.parse_confidence, "high");
  assert.ok(features.table_count >= 2);
  assert.ok(features.where_columns.includes("status"));
  assert.ok(features.where_columns.includes("email_key"));
  assert.ok(features.join_columns.includes("user_id"));
  assert.ok(features.uses_functions.includes("lower"));
  assert.ok(features.uses_functions.includes("count"));
});

test("parser errors fall back to low-confidence feature extraction", () => {
  const sql = readFileSync(join(fixtureDirectory, "parser_error_unterminated_string.sql"), "utf8");
  const parsed = parseSqlToAst(sql);

  assert.equal(isSqlParseError(parsed), true);
  assert.ok(isSqlParseError(parsed));
  assert.equal(parsed.kind, "parse_error");

  const features = extractQueryFeatures(sql);

  assert.equal(features.statement_type, "SELECT");
  assert.equal(features.select_star, true);
  assert.equal(features.where_present, true);
  assert.equal(features.parse_confidence, "low");
});
