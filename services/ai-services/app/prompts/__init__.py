from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

_PROMPT_DIR = Path(__file__).resolve().parent


def _normalize(value: Any) -> Any:
    if isinstance(value, BaseModel):
        if hasattr(value, "model_dump"):
            return value.model_dump()
        return value.dict()
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, tuple):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    return value


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    normalized = _normalize(value)
    try:
        return json.dumps(normalized, ensure_ascii=True, indent=2, sort_keys=True)
    except TypeError:
        return json.dumps(
            normalized,
            ensure_ascii=True,
            indent=2,
            sort_keys=True,
            default=str,
        )


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
    policy_flags: Any = None,
    allowed_reco_types: Any = None,
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
        policy_flags=_stringify(policy_flags or []),
        allowed_reco_types=_stringify(allowed_reco_types or []),
    )


def render_insights_prompt(
    *,
    plan_summary: Any,
    rule_findings: Any,
    user_intent: Optional[str],
    policy_flags: Any,
    allowed_reco_types: Any,
) -> str:
    template_path = _PROMPT_DIR / "insights.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(
        plan_summary=_stringify(plan_summary),
        rule_findings=_stringify(rule_findings),
        user_intent=user_intent or "None",
        policy_flags=_stringify(policy_flags),
        allowed_reco_types=_stringify(allowed_reco_types),
    )


def render_insights_planner_prompt(
    *,
    plan_summary: Any,
    rule_findings: Any,
    user_intent: Optional[str],
) -> str:
    template_path = _PROMPT_DIR / "insights_planner.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(
        plan_summary=_stringify(plan_summary),
        rule_findings=_stringify(rule_findings),
        user_intent=user_intent or "None",
    )


def _format_messages(messages: Any) -> str:
    if not isinstance(messages, list) or not messages:
        return "None"
    lines = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if not isinstance(role, str) or not isinstance(content, str):
            continue
        cleaned = content.strip()
        if not cleaned:
            continue
        lines.append(f"{role.upper()}: {cleaned}")
    return "\n".join(lines) if lines else "None"


def render_query_chat_prompt(
    *,
    sql_text: str,
    schema: Any,
    indexes: Any,
    explain_output: Any,
    db_engine: str,
    project_id: str,
    messages: Any,
    policy_flags: Any = None,
) -> str:
    template_path = _PROMPT_DIR / "query_chat.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(
        sql_text=sql_text,
        schema=_stringify(schema),
        indexes=_stringify(indexes),
        explain_output=_stringify(explain_output),
        db_engine=db_engine,
        project_id=project_id,
        conversation=_format_messages(messages),
        policy_flags=_stringify(policy_flags or []),
    )


def render_policy_planner_prompt(*, user_intent: Optional[str]) -> str:
    template_path = _PROMPT_DIR / "policy_planner.md"
    template = template_path.read_text(encoding="utf-8")
    return template.format(user_intent=user_intent or "None")
