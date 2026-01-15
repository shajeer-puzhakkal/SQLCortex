from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .ai_response_parser import parse_insights_response
from .models import AiInsightsRequest, AiInsightsResponse, AiSqlResponseMeta
from .prompts import render_insights_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Return only valid JSON that matches the schema."
)


def _handle_request(payload: AiInsightsRequest) -> AiInsightsResponse:
    user_prompt = render_insights_prompt(
        plan_summary=payload.plan_summary,
        rule_findings=payload.rule_findings,
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
        parsed = parse_insights_response(result.text)
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
    return AiInsightsResponse(meta=meta, **parsed)


@router.post("/insights", response_model=AiInsightsResponse)
def insights(payload: AiInsightsRequest) -> AiInsightsResponse:
    return _handle_request(payload)
