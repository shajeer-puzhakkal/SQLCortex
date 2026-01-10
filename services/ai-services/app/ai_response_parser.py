from __future__ import annotations

import json
from typing import Any, Dict, List

RISK_LEVELS = {"low", "medium", "high"}


def _extract_json_blob(text: str) -> str:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("AI response did not contain JSON")
    return text[start : end + 1]


def _to_string_list(value: Any, field_name: str) -> List[str]:
    if not isinstance(value, list):
        raise ValueError(f"Missing or invalid {field_name}")
    result: List[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(f"Invalid item in {field_name}")
        cleaned = item.strip()
        if cleaned:
            result.append(cleaned)
    return result


def parse_ai_response(text: str) -> Dict[str, Any]:
    blob = _extract_json_blob(text)
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise ValueError(f"AI response JSON parse error: {exc}") from exc

    if not isinstance(payload, dict):
        raise ValueError("AI response JSON was not an object")

    summary = payload.get("summary")
    if isinstance(summary, list):
        summary_text = " ".join(
            [item.strip() for item in summary if isinstance(item, str) and item.strip()]
        )
    elif isinstance(summary, str):
        summary_text = summary.strip()
    else:
        summary_text = ""

    if not summary_text:
        raise ValueError("Missing or empty summary")

    findings = _to_string_list(payload.get("findings"), "findings")
    recommendations = _to_string_list(payload.get("recommendations"), "recommendations")

    risk_level = payload.get("risk_level")
    if not isinstance(risk_level, str):
        raise ValueError("Missing or invalid risk_level")
    normalized_risk = risk_level.strip().lower()
    if normalized_risk not in RISK_LEVELS:
        raise ValueError("risk_level must be low, medium, or high")

    return {
        "summary": summary_text,
        "findings": findings,
        "recommendations": recommendations,
        "risk_level": normalized_risk,
    }
