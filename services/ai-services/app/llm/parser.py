from __future__ import annotations

import json
from typing import Any, List, Optional

from .types import LlmSuggestion


def _extract_json_blob(text: str) -> Optional[str]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return text[start : end + 1]


def _to_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    result: List[str] = []
    for item in value:
        if isinstance(item, str):
            cleaned = item.strip()
            if cleaned:
                result.append(cleaned)
    return result


def parse_llm_response(text: str) -> LlmSuggestion:
    blob = _extract_json_blob(text)
    if not blob:
        return LlmSuggestion(error="LLM response did not contain JSON", used=True)

    try:
        payload = json.loads(blob)
    except json.JSONDecodeError as exc:
        return LlmSuggestion(error=f"LLM response JSON parse error: {exc}", used=True)

    if not isinstance(payload, dict):
        return LlmSuggestion(error="LLM response JSON was not an object", used=True)

    summary = _to_string_list(payload.get("summary"))
    notes = _to_string_list(payload.get("notes"))

    rewrite_sql = payload.get("rewrite_sql")
    if isinstance(rewrite_sql, str):
        rewrite_sql = rewrite_sql.strip()
        if not rewrite_sql:
            rewrite_sql = None
    elif rewrite_sql is not None:
        rewrite_sql = None

    confidence = payload.get("confidence")
    try:
        confidence_value = float(confidence)
    except (TypeError, ValueError):
        confidence_value = 0.3
    confidence_value = max(0.0, min(1.0, confidence_value))

    return LlmSuggestion(
        summary=summary,
        rewrite_sql=rewrite_sql,
        notes=notes,
        confidence=confidence_value,
        used=True,
    )
