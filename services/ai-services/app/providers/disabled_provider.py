import json


def generate_text(system_prompt: str, user_prompt: str, *, model: str, timeout_ms: int) -> str:
    payload = {
        "summary": "AI provider is disabled for this service.",
        "findings": [],
        "recommendations": [],
        "risk_level": "low",
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
