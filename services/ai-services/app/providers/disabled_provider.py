import json


def generate_text(system_prompt: str, user_prompt: str, *, model: str, timeout_ms: int) -> str:
    message = "AI provider is disabled for this service."
    payload = {
        "summary": message,
        "findings": [],
        "recommendations": [],
        "risk_level": "low",
        "explanation": message,
        "suggestions": [],
        "warnings": [message],
        "assumptions": [],
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
