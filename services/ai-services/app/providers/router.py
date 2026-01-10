from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional

from . import disabled_provider, mock_provider, ollama_provider, openai_provider

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "ollama": "llama3.1",
    "mock": "mock-model",
    "disabled": "disabled",
}


@dataclass
class ProviderResult:
    text: str
    provider: str
    model: str
    latency_ms: int


def _read_timeout_ms() -> int:
    raw = (os.getenv("AI_TIMEOUT_MS") or "30000").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 30000
    return max(100, value)


def _resolve_provider() -> str:
    provider = (os.getenv("AI_PROVIDER") or "disabled").strip().lower()
    if provider not in {"openai", "ollama", "mock", "disabled"}:
        return "disabled"
    return provider


def _resolve_model(provider: str, model_override: Optional[str]) -> str:
    if model_override:
        return model_override.strip()
    env_model = (os.getenv("AI_MODEL") or "").strip()
    if env_model:
        return env_model
    return DEFAULT_MODELS.get(provider, "unknown")


def route_generate_text(
    system_prompt: str,
    user_prompt: str,
    *,
    model: Optional[str] = None,
    timeout_ms: Optional[int] = None,
) -> ProviderResult:
    provider = _resolve_provider()
    resolved_model = _resolve_model(provider, model)
    resolved_timeout = timeout_ms if timeout_ms is not None else _read_timeout_ms()

    if provider == "openai":
        generator = openai_provider.generate_text
    elif provider == "ollama":
        generator = ollama_provider.generate_text
    elif provider == "mock":
        generator = mock_provider.generate_text
    else:
        generator = disabled_provider.generate_text

    start = time.perf_counter()
    text = generator(
        system_prompt,
        user_prompt,
        model=resolved_model,
        timeout_ms=resolved_timeout,
    )
    latency_ms = int((time.perf_counter() - start) * 1000)

    return ProviderResult(
        text=text,
        provider=provider,
        model=resolved_model,
        latency_ms=latency_ms,
    )
