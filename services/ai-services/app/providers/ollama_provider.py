from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request

from .errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError

DEFAULT_BASE_URL = "http://ollama:11434"


def generate_text(system_prompt: str, user_prompt: str, *, model: str, timeout_ms: int) -> str:
    base_url = os.getenv("OLLAMA_BASE_URL") or DEFAULT_BASE_URL
    endpoint = base_url.rstrip("/") + "/api/chat"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
    }

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    timeout_seconds = max(int(timeout_ms), 1) / 1000.0
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ProviderUnavailableError(f"Ollama HTTP error: {exc.code}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, socket.timeout):
            raise ProviderTimeoutError("Ollama request timed out") from exc
        raise ProviderUnavailableError(f"Ollama connection error: {exc.reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise ProviderTimeoutError("Ollama request timed out") from exc
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(f"Ollama response JSON parse error: {exc}") from exc

    message = data.get("message")
    if isinstance(message, dict):
        content = message.get("content")
    else:
        content = data.get("response")

    if not isinstance(content, str):
        raise ProviderResponseError("Ollama response missing content")
    return content.strip()
