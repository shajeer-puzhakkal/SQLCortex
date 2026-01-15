from __future__ import annotations

import json
from typing import Any, Dict, List

RISK_LEVELS = {"low", "medium", "high"}
CONFIDENCE_LEVELS = {"low", "medium", "high"}


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


def _optional_string_list(value: Any, field_name: str) -> List[str]:
    if value is None:
        return []
    return _to_string_list(value, field_name)


def _parse_suggestion(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Invalid suggestion entry")
    title = value.get("title")
    description = value.get("description")
    confidence = value.get("confidence")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("Suggestion title is required")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("Suggestion description is required")
    if not isinstance(confidence, str) or confidence.strip().lower() not in CONFIDENCE_LEVELS:
        raise ValueError("Suggestion confidence must be low, medium, or high")
    tradeoffs = _optional_string_list(value.get("tradeoffs"), "tradeoffs")
    return {
        "title": title.strip(),
        "description": description.strip(),
        "confidence": confidence.strip().lower(),
        "tradeoffs": tradeoffs,
    }


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


def parse_insights_response(text: str) -> Dict[str, Any]:
    blob = _extract_json_blob(text)
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise ValueError(f"AI response JSON parse error: {exc}") from exc

    if not isinstance(payload, dict):
        raise ValueError("AI response JSON was not an object")

    explanation = payload.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip():
        raise ValueError("Missing or empty explanation")

    suggestions_raw = payload.get("suggestions", [])
    if suggestions_raw is None:
        suggestions_raw = []
    if not isinstance(suggestions_raw, list):
        raise ValueError("Missing or invalid suggestions")
    suggestions = [_parse_suggestion(item) for item in suggestions_raw]

    warnings = _optional_string_list(payload.get("warnings"), "warnings")
    assumptions = _optional_string_list(payload.get("assumptions"), "assumptions")

    return {
        "explanation": explanation.strip(),
        "suggestions": suggestions,
        "warnings": warnings,
        "assumptions": assumptions,
    }
