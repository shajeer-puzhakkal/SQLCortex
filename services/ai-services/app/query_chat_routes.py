from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .ai_response_parser import parse_chat_response
from .models import QueryChatRequest, QueryChatResponse, AiSqlResponseMeta
from .prompts import render_query_chat_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai/query", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Follow the user prompt and return only valid JSON."
)


@router.post("/chat", response_model=QueryChatResponse)
def query_chat(payload: QueryChatRequest) -> QueryChatResponse:
    messages = [
        message.model_dump() if hasattr(message, "model_dump") else message.dict()
        for message in payload.messages
    ]
    user_prompt = render_query_chat_prompt(
        sql_text=payload.sql_text,
        schema=payload.schema,
        indexes=payload.indexes,
        explain_output=payload.explain_output,
        db_engine=payload.db_engine,
        project_id=payload.project_id,
        messages=messages,
    )

    try:
        result = route_generate_text(_SYSTEM_PROMPT, user_prompt)
    except ProviderTimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail={"code": "ai_timeout", "message": str(exc)},
        ) from exc
    except ProviderUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "ai_provider_unavailable", "message": str(exc)},
        ) from exc
    except ProviderResponseError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_provider_error", "message": str(exc)},
        ) from exc

    try:
        parsed = parse_chat_response(result.text)
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_response_invalid", "message": str(exc)},
        ) from exc

    meta = AiSqlResponseMeta(
        provider=result.provider,
        model=result.model,
        latency_ms=result.latency_ms,
    )
    return QueryChatResponse(meta=meta, **parsed)
