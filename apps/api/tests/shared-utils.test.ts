import { test } from "node:test";
import assert from "node:assert/strict";
import { hashSql, normalizeSql, redactError } from "../../packages/shared/src";

test("normalizeSql removes comments and collapses whitespace", () => {
  const input = "SELECT  *  -- comment\nFROM users /* block */ WHERE id = 1";
  const normalized = normalizeSql(input);
  assert.equal(normalized, "SELECT * FROM users WHERE id = 1");
});

test("hashSql is consistent for normalized SQL", () => {
  const base = normalizeSql("SELECT * FROM users");
  const variant = normalizeSql("SELECT  * FROM users -- trailing comment");
  assert.equal(hashSql(base), hashSql(variant));
});

test("redactError removes host, user, and database identifiers", () => {
  const message =
    'FATAL: password authentication failed for user "alice" on host "db.prod.local" database "sales"';
  const redacted = redactError(message);
  assert.ok(!redacted.includes("alice"));
  assert.ok(!redacted.includes("db.prod.local"));
  assert.ok(!redacted.includes("sales"));
});
