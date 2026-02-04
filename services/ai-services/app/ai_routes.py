from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any, List
import logging

from fastapi import APIRouter, HTTPException

from .ai_response_parser import parse_ai_response, parse_planner_response
from .models import AiSqlRequest, AiSqlResponse, AiSqlResponseMeta
from .prompts import render_policy_planner_prompt, render_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai/sql", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Follow the user prompt and return only valid JSON."
)
_PLANNER_SYSTEM_PROMPT = "You are a policy planner. Return only valid JSON."

ALLOWED_RECO_TYPES = ["index", "rewrite", "stats", "memory"]
DISALLOWED_SCHEMA_KEYWORDS = [
    "foreign key",
    "fk",
    "constraint",
    "referential",
    "schema design",
    "normalize",
    "denormalize",
    "join table",
    "relationship",
    "primary key",
]
HARDBLOCK_FK_KEYWORDS = [
    "foreign key",
    "fk",
    "constraint",
    "referential",
]


@dataclass(frozen=True)
class PlannerPolicy:
    allow_schema_advice: bool
    allow_fk_recommendations: bool
    policy_flags: List[str]


DEFAULT_POLICY = PlannerPolicy(
    allow_schema_advice=False,
    allow_fk_recommendations=False,
    policy_flags=["no_schema_inference", "no_fk_reco"],
)

logger = logging.getLogger(__name__)


def _count_keys(value: Any) -> int:
    return len(value) if isinstance(value, dict) else 0


def _policy_gating_enabled() -> bool:
    raw = (os.getenv("AI_POLICY_GATING") or "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _run_planner(user_intent: str | None) -> PlannerPolicy:
    prompt = render_policy_planner_prompt(user_intent=user_intent)
    logger.info("AI SQL planner prompt length: %s", len(prompt))
    try:
        result = route_generate_text(_PLANNER_SYSTEM_PROMPT, prompt)
        parsed = parse_planner_response(result.text)
    except Exception as exc:
        logger.warning("AI SQL planner failed, using defaults: %s", exc)
        return DEFAULT_POLICY

    policy_flags = parsed.get("policy_flags", [])
    allow_schema = bool(parsed.get("allow_schema_advice"))
    allow_fk = bool(parsed.get("allow_fk_recommendations"))

    if not allow_schema and "no_schema_inference" not in policy_flags:
        policy_flags.append("no_schema_inference")
    if not allow_fk and "no_fk_reco" not in policy_flags:
        policy_flags.append("no_fk_reco")

    return PlannerPolicy(
        allow_schema_advice=allow_schema,
        allow_fk_recommendations=allow_fk,
        policy_flags=policy_flags,
    )


def _filter_recommendations(recommendations: List[str]) -> List[str]:
    if not recommendations:
        return []
    filtered: List[str] = []
    for recommendation in recommendations:
        lowered = recommendation.lower()
        if any(keyword in lowered for keyword in HARDBLOCK_FK_KEYWORDS):
            continue
        if any(keyword in lowered for keyword in DISALLOWED_SCHEMA_KEYWORDS):
            continue
        filtered.append(recommendation)
    return filtered


def _handle_request(template_name: str, payload: AiSqlRequest) -> AiSqlResponse:
    logger.info(
        "AI SQL request: action=%s project_id=%s db_engine=%s sql_len=%s explain_len=%s schema_keys=%s indexes_keys=%s user_intent=%s",
        template_name,
        payload.project_id,
        payload.db_engine,
        len(payload.sql_text or ""),
        len(payload.explain_output or ""),
        _count_keys(payload.schema),
        _count_keys(payload.indexes),
        "yes" if payload.user_intent else "no",
    )
    policy = DEFAULT_POLICY
    if _policy_gating_enabled():
        policy = _run_planner(payload.user_intent)
    logger.info(
        "AI SQL policy: action=%s gating=%s allow_schema=%s allow_fk=%s flags=%s",
        template_name,
        _policy_gating_enabled(),
        policy.allow_schema_advice,
        policy.allow_fk_recommendations,
        policy.policy_flags,
    )

    user_prompt = render_prompt(
        template_name,
        sql_text=payload.sql_text,
        schema=payload.schema,
        indexes=payload.indexes,
        explain_output=payload.explain_output,
        db_engine=payload.db_engine,
        project_id=payload.project_id,
        user_intent=payload.user_intent,
        policy_flags=policy.policy_flags,
        allowed_reco_types=ALLOWED_RECO_TYPES,
    )
    logger.info("AI SQL prompt length: action=%s length=%s", template_name, len(user_prompt))

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
        logger.warning("AI SQL response invalid: action=%s error=%s", template_name, exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_response_invalid", "message": str(exc)},
        ) from exc

    if _policy_gating_enabled():
        before = len(parsed.get("recommendations", []) or [])
        parsed["recommendations"] = _filter_recommendations(parsed.get("recommendations", []))
        after = len(parsed.get("recommendations", []) or [])
        if before != after:
            logger.info(
                "AI SQL recommendations filtered: action=%s before=%s after=%s",
                template_name,
                before,
                after,
            )
    logger.info(
        "AI SQL response: action=%s provider=%s model=%s latency_ms=%s findings=%s recommendations=%s risk=%s",
        template_name,
        result.provider,
        result.model,
        result.latency_ms,
        len(parsed.get("findings", []) or []),
        len(parsed.get("recommendations", []) or []),
        parsed.get("risk_level"),
    )

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
