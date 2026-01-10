from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .ai_response_parser import parse_ai_response
from .models import AiSqlRequest, AiSqlResponse, AiSqlResponseMeta
from .prompts import render_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai/sql", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Follow the user prompt and return only valid JSON."
)


def _handle_request(template_name: str, payload: AiSqlRequest) -> AiSqlResponse:
    user_prompt = render_prompt(
        template_name,
        sql_text=payload.sql_text,
        schema=payload.schema,
        indexes=payload.indexes,
        explain_output=payload.explain_output,
        db_engine=payload.db_engine,
        project_id=payload.project_id,
        user_intent=payload.user_intent,
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
        parsed = parse_ai_response(result.text)
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
    return AiSqlResponse(meta=meta, **parsed)


@router.post("/explain", response_model=AiSqlResponse)
def explain_sql(payload: AiSqlRequest) -> AiSqlResponse:
    return _handle_request("explain", payload)


@router.post("/optimize", response_model=AiSqlResponse)
def optimize_sql(payload: AiSqlRequest) -> AiSqlResponse:
    return _handle_request("optimize", payload)


@router.post("/index-suggest", response_model=AiSqlResponse)
def index_suggest_sql(payload: AiSqlRequest) -> AiSqlResponse:
    return _handle_request("index_suggest", payload)


@router.post("/risk-check", response_model=AiSqlResponse)
def risk_check_sql(payload: AiSqlRequest) -> AiSqlResponse:
    return _handle_request("risk_check", payload)
