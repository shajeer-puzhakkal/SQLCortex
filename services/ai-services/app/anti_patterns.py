from __future__ import annotations

import re
from typing import List


def _strip_sql_comments(sql: str) -> str:
    sql = re.sub(r"--.*?$", "", sql, flags=re.MULTILINE)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    return sql


def detect_anti_patterns(sql: str) -> List[str]:
    """
    Lightweight SQL-only checks; uses regex to avoid heavy parsing.
    """
    normalized = _strip_sql_comments(sql or "").lower()
    findings: List[str] = []

    if "select *" in normalized:
        findings.append("SELECT * returns wide rows; project only needed columns.")

    if " limit " not in normalized and not normalized.strip().startswith("explain"):
        findings.append("Missing LIMIT clause may scan more rows than necessary.")

    func_pattern = re.compile(r"\bwhere\b[^;]*\b(lower|upper|date_trunc|trim|substr|substring|coalesce)\s*\(")
    if func_pattern.search(normalized):
        findings.append("Functions in WHERE can prevent index usage; precompute or index computed column.")

    if "::" in normalized:
        findings.append("Implicit casts detected; align column and literal types to avoid casted scans.")

    in_pattern = re.compile(r"\bin\s*\(([^)]+)\)")
    for match in in_pattern.finditer(normalized):
        items = match.group(1).split(",")
        if len(items) > 20:
            findings.append("Large IN list; consider temporary table or JOIN to avoid bloated predicates.")
            break

    return findings
