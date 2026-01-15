from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

_PROMPT_DIR = Path(__file__).resolve().parent


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True)


def render_prompt(
    template_name: str,
    *,
    sql_text: str,
    schema: Any,
    indexes: Any,
    explain_output: str,
    db_engine: str,
    project_id: str,
    user_intent: Optional[str],
) -> str:
    template_path = _PROMPT_DIR / f"{template_name}.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(
        sql_text=sql_text,
        schema=_stringify(schema),
        indexes=_stringify(indexes),
        explain_output=explain_output,
        db_engine=db_engine,
        project_id=project_id,
        user_intent=user_intent or "None",
    )


def render_insights_prompt(
    *,
    plan_summary: Any,
    rule_findings: Any,
    user_intent: Optional[str],
) -> str:
    template_path = _PROMPT_DIR / "insights.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(
        plan_summary=_stringify(plan_summary),
        rule_findings=_stringify(rule_findings),
        user_intent=user_intent or "None",
    )
