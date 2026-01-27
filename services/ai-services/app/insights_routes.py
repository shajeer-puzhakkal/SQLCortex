from __future__ import annotations

from fastapi import APIRouter, HTTPException
import logging

from .ai_response_parser import parse_insights_response
from .models import AiInsightsRequest, AiInsightsResponse, AiSqlResponseMeta
from .prompts import render_insights_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Return only valid JSON that matches the schema."
)

logger = logging.getLogger(__name__)


def _handle_request(payload: AiInsightsRequest) -> AiInsightsResponse:
    logger.info(
        "AI insights request: plan_summary_keys=%s rule_findings=%s user_intent=%s",
        list(payload.plan_summary.keys()) if isinstance(payload.plan_summary, dict) else None,
        len(payload.rule_findings) if payload.rule_findings else 0,
        "yes" if payload.user_intent else "no",
    )
    user_prompt = render_insights_prompt(
        plan_summary=payload.plan_summary,
        rule_findings=payload.rule_findings,
        user_intent=payload.user_intent,
    )
    logger.info("AI insights prompt length: %s", len(user_prompt))

    try:
        result = route_generate_text(_SYSTEM_PROMPT, user_prompt)
    except ProviderTimeoutError as exc:
        logger.warning("AI insights provider timeout: %s", exc)
        raise HTTPException(
            status_code=504,
            detail={"code": "ai_timeout", "message": str(exc)},
        ) from exc
    except ProviderUnavailableError as exc:
        logger.warning("AI insights provider unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail={"code": "ai_provider_unavailable", "message": str(exc)},
        ) from exc
    except ProviderResponseError as exc:
        logger.warning("AI insights provider error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_provider_error", "message": str(exc)},
        ) from exc

    try:
        parsed = parse_insights_response(result.text)
    except ValueError as exc:
        logger.warning("AI insights response invalid: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_response_invalid", "message": str(exc)},
        ) from exc

    meta = AiSqlResponseMeta(
        provider=result.provider,
        model=result.model,
        latency_ms=result.latency_ms,
    )
    logger.info(
        "AI insights response: provider=%s model=%s latency_ms=%s",
        result.provider,
        result.model,
        result.latency_ms,
    )
    return AiInsightsResponse(meta=meta, **parsed)


@router.post("/insights", response_model=AiInsightsResponse)
def insights(payload: AiInsightsRequest) -> AiInsightsResponse:
    return _handle_request(payload)
