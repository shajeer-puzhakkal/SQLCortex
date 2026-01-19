from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request

from .errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError

DEFAULT_BASE_URL = "https://api.openai.com/v1"


def generate_text(system_prompt: str, user_prompt: str, *, model: str, timeout_ms: int) -> str:
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("LLM_API_KEY")
    if not api_key:
        raise ProviderUnavailableError("OPENAI_API_KEY is not set")

    base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL
    endpoint = base_url.rstrip("/") + "/chat/completions"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
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
            "Authorization": f"Bearer {api_key}",
        },
    )

    timeout_seconds = max(int(timeout_ms), 1) / 1000.0
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ProviderUnavailableError(f"OpenAI HTTP error: {exc.code}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, socket.timeout):
            raise ProviderTimeoutError("OpenAI request timed out") from exc
        raise ProviderUnavailableError(f"OpenAI connection error: {exc.reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise ProviderTimeoutError("OpenAI request timed out") from exc
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(f"OpenAI response JSON parse error: {exc}") from exc

    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ProviderResponseError("OpenAI response missing choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ProviderResponseError("OpenAI response missing message")
    content = message.get("content")
    if not isinstance(content, str):
        raise ProviderResponseError("OpenAI response missing content")
    return content.strip()
