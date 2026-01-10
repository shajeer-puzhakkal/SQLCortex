import json


def generate_text(system_prompt: str, user_prompt: str, *, model: str, timeout_ms: int) -> str:
    payload = {
        "summary": "Mock response from SQLCortex.",
        "findings": [
            "Mock finding: sequential scan on large table.",
            "Mock finding: join order could be improved.",
        ],
        "recommendations": [
            "Mock recommendation: add index on filter column.",
            "Mock recommendation: reduce selected columns to lower I/O.",
        ],
        "risk_level": "low",
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
