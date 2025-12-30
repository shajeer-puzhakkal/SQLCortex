from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional, Protocol


class LlmProvider(Protocol):
    def complete(self, prompt: str) -> str:
        raise NotImplementedError


@dataclass
class ProviderConfig:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float


class OpenAICompatibleProvider:
    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    def complete(self, prompt: str) -> str:
        endpoint = self.config.base_url.rstrip("/") + "/chat/completions"
        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": "You are a helpful SQL performance assistant."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        }
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.config.api_key}",
            },
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
        choices = data.get("choices") or []
        if not choices or not isinstance(choices, list):
            raise ValueError("LLM response missing choices")
        message = choices[0].get("message") or {}
        content = message.get("content")
        if not isinstance(content, str):
            raise ValueError("LLM response missing content")
        return content


class MockProvider:
    def complete(self, prompt: str) -> str:
        return json.dumps(
            {
                "summary": [
                    "The plan shows heavy scans and join work that drive most of the cost.",
                    "Indexing common filters and reducing wide rows should reduce I/O.",
                ],
                "rewrite_sql": None,
                "notes": ["Mock provider returned no rewrite."],
                "confidence": 0.35,
            }
        )


def get_provider() -> Optional[LlmProvider]:
    provider = (os.getenv("LLM_PROVIDER") or "disabled").strip().lower()
    if provider in {"", "disabled", "none", "off"}:
        return None
    if provider == "mock":
        return MockProvider()

    base_url = os.getenv("LLM_BASE_URL")
    api_key = os.getenv("LLM_API_KEY")
    model = os.getenv("LLM_MODEL") or "gpt-4o-mini"
    timeout_seconds = float(os.getenv("LLM_TIMEOUT_SECONDS") or "10")

    if not base_url or not api_key:
        return None

    return OpenAICompatibleProvider(
        ProviderConfig(
            base_url=base_url,
            api_key=api_key,
            model=model,
            timeout_seconds=timeout_seconds,
        )
    )
