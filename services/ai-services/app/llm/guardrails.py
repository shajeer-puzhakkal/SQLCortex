from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import sqlglot
from sqlglot import expressions as exp


FORBIDDEN_KEYWORDS = {
    "insert",
    "update",
    "delete",
    "alter",
    "drop",
    "truncate",
    "create",
    "grant",
    "revoke",
}


@dataclass
class GuardrailResult:
    allowed: bool
    reason: Optional[str] = None


def _strip_comments_and_literals(sql: str) -> str:
    without_line = re.sub(r"--.*?$", "", sql, flags=re.MULTILINE)
    without_block = re.sub(r"/\*.*?\*/", "", without_line, flags=re.DOTALL)
    without_single = re.sub(r"'(?:''|[^'])*'", "''", without_block)
    without_double = re.sub(r'"(?:\\"|[^"])*"', '""', without_single)
    return without_double


def _contains_forbidden_keyword(sql: str) -> Optional[str]:
    lowered = _strip_comments_and_literals(sql).lower()
    for keyword in FORBIDDEN_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", lowered):
            return keyword
    return None


def guard_rewrite(sql: str) -> GuardrailResult:
    if not sql or not sql.strip():
        return GuardrailResult(False, "Rewrite SQL is empty.")

    keyword = _contains_forbidden_keyword(sql)
    if keyword:
        return GuardrailResult(False, f"Rewrite contains forbidden keyword: {keyword}.")

    try:
        statements = sqlglot.parse(sql, read="postgres")
    except Exception as exc:
        return GuardrailResult(False, f"Rewrite SQL failed to parse: {exc}.")

    if len(statements) != 1:
        return GuardrailResult(False, "Rewrite must contain a single statement.")

    statement = statements[0]
    allowed_roots = (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Explain)
    if not isinstance(statement, allowed_roots):
        return GuardrailResult(False, "Rewrite must be a SELECT, WITH, or EXPLAIN statement.")

    disallowed = (
        exp.Insert,
        exp.Update,
        exp.Delete,
        exp.Alter,
        exp.Drop,
        exp.Truncate,
        exp.Create,
        exp.Grant,
        exp.Revoke,
    )
    if any(statement.find_all(*disallowed)):
        return GuardrailResult(False, "Rewrite contains non-read-only operations.")

    return GuardrailResult(True, None)
