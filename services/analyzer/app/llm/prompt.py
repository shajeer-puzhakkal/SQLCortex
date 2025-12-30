from __future__ import annotations

import json
from typing import List, Optional

from ..models import Finding, IndexSuggestion


def build_prompt(
    sql: str,
    findings: List[Finding],
    suggested_indexes: List[IndexSuggestion],
    anti_patterns: List[str],
    primary_bottleneck: Optional[str],
) -> str:
    context = {
        "sql": sql,
        "primary_bottleneck": primary_bottleneck,
        "findings": [
            {
                "code": f.code,
                "title": f.title,
                "severity": f.severity,
                "impact": f.impact,
                "remediation": f.remediation,
            }
            for f in findings
        ],
        "suggested_indexes": [
            {
                "table": s.table,
                "columns": s.columns,
                "sql": s.sql,
                "reason": s.reason,
            }
            for s in suggested_indexes
        ],
        "anti_patterns": anti_patterns,
    }

    instructions = (
        "You are a SQL performance assistant. Use the provided context to create a plain-English "
        "summary of findings and (optionally) a single read-only rewrite. "
        "Output ONLY valid JSON with the following keys:\n"
        '- "summary": array of 2-5 short sentences\n'
        '- "rewrite_sql": string SQL or null (read-only SELECT/WITH/EXPLAIN only)\n'
        '- "notes": array of short notes (max 4 items)\n'
        '- "confidence": number between 0 and 1\n'
        "If you cannot provide a rewrite, set rewrite_sql to null and explain why in notes."
    )

    return (
        f"{instructions}\n\n"
        "Context JSON:\n"
        f"{json.dumps(context, ensure_ascii=True, indent=2)}"
    )
