import assert from "node:assert/strict";
import { test } from "node:test";
import { getActiveStatement } from "../src/parse/getActiveStatement";

test("getActiveStatement selects the statement under the cursor in a multi-statement document", () => {
  const documentText = "SELECT 1;\n\nSELECT 2 FROM users;\nSELECT 3;";
  const cursorOffset = documentText.indexOf("FROM users");
  const active = getActiveStatement(documentText, cursorOffset);

  assert.equal(active.sql, "SELECT 2 FROM users");
  assert.equal(active.start, documentText.indexOf("SELECT 2"));
  assert.equal(active.end, documentText.indexOf(";\nSELECT 3"));
});

test("getActiveStatement ignores semicolons inside string literals", () => {
  const documentText = "SELECT ';' AS literal;\nSELECT 2;";
  const cursorOffset = documentText.indexOf("literal");
  const active = getActiveStatement(documentText, cursorOffset);

  assert.equal(active.sql, "SELECT ';' AS literal");
});
