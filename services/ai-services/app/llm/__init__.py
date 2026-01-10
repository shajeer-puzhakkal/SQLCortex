from __future__ import annotations

from typing import List, Optional

from .parser import parse_llm_response
from .prompt import build_prompt
from .provider import get_provider
from .types import LlmSuggestion


def generate_llm_suggestions(
    sql: str,
    findings: List[object],
    suggested_indexes: List[object],
    anti_patterns: List[str],
    primary_bottleneck: Optional[str],
) -> LlmSuggestion:
    provider = get_provider()
    if provider is None:
        return LlmSuggestion(error="LLM provider not configured", used=False)

    prompt = build_prompt(sql, findings, suggested_indexes, anti_patterns, primary_bottleneck)
    try:
        response_text = provider.complete(prompt)
    except Exception as exc:  # pragma: no cover - provider/network failures
        return LlmSuggestion(error=f"LLM provider error: {exc}", used=True)

    parsed = parse_llm_response(response_text)
    parsed.used = True
    return parsed
