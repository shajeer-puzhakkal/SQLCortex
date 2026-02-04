from __future__ import annotations

from dataclasses import dataclass
import os
from typing import List
import logging

from fastapi import APIRouter, HTTPException

from .ai_response_parser import parse_chat_response, parse_planner_response
from .models import QueryChatRequest, QueryChatResponse, AiSqlResponseMeta
from .prompts import render_policy_planner_prompt, render_query_chat_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai/query", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Follow the user prompt and return only valid JSON."
)
_PLANNER_SYSTEM_PROMPT = "You are a policy planner. Return only valid JSON."

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


def _policy_gating_enabled() -> bool:
    raw = (os.getenv("AI_POLICY_GATING") or "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _run_planner(user_intent: str | None) -> PlannerPolicy:
    prompt = render_policy_planner_prompt(user_intent=user_intent)
    logger.info("AI chat planner prompt length: %s", len(prompt))
    try:
        result = route_generate_text(_PLANNER_SYSTEM_PROMPT, prompt)
        parsed = parse_planner_response(result.text)
    except Exception as exc:
        logger.warning("AI chat planner failed, using defaults: %s", exc)
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


def _filter_answer(answer: str) -> str:
    if not answer:
        return answer
    sentences = [chunk.strip() for chunk in answer.replace("\n", " ").split(".")]
    kept: List[str] = []
    for sentence in sentences:
        if not sentence:
            continue
        lowered = sentence.lower()
        if any(keyword in lowered for keyword in HARDBLOCK_FK_KEYWORDS):
            continue
        if any(keyword in lowered for keyword in DISALLOWED_SCHEMA_KEYWORDS):
            continue
        kept.append(sentence)
    if not kept:
        return "I don't have enough information to answer that from the provided context."
    return ". ".join(kept).strip() + "."


@router.post("/chat", response_model=QueryChatResponse)
def query_chat(payload: QueryChatRequest) -> QueryChatResponse:
    messages = [
        message.model_dump() if hasattr(message, "model_dump") else message.dict()
        for message in payload.messages
    ]
    logger.info(
        "AI chat request: project_id=%s db_engine=%s sql_len=%s explain_len=%s schema_keys=%s indexes_keys=%s messages=%s user_intent=%s",
        payload.project_id,
        payload.db_engine,
        len(payload.sql_text or ""),
        len(payload.explain_output or ""),
        len(payload.schema) if isinstance(payload.schema, dict) else 0,
        len(payload.indexes) if isinstance(payload.indexes, dict) else 0,
        len(messages),
        "yes" if payload.user_intent else "no",
    )
    policy = DEFAULT_POLICY
    if _policy_gating_enabled():
        policy = _run_planner(payload.user_intent)
    logger.info(
        "AI chat policy: gating=%s allow_schema=%s allow_fk=%s flags=%s",
        _policy_gating_enabled(),
        policy.allow_schema_advice,
        policy.allow_fk_recommendations,
        policy.policy_flags,
    )
    user_prompt = render_query_chat_prompt(
        sql_text=payload.sql_text,
        schema=payload.schema,
        indexes=payload.indexes,
        explain_output=payload.explain_output,
        db_engine=payload.db_engine,
        project_id=payload.project_id,
        messages=messages,
        policy_flags=policy.policy_flags,
    )
    logger.info("AI chat prompt length: %s", len(user_prompt))

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
        logger.warning("AI chat response invalid: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "ai_response_invalid", "message": str(exc)},
        ) from exc

    if _policy_gating_enabled():
        before = len(parsed.get("answer", "") or "")
        parsed["answer"] = _filter_answer(parsed.get("answer", ""))
        after = len(parsed.get("answer", "") or "")
        if before != after:
            logger.info("AI chat answer filtered: before_len=%s after_len=%s", before, after)
    logger.info(
        "AI chat response: provider=%s model=%s latency_ms=%s answer_len=%s",
        result.provider,
        result.model,
        result.latency_ms,
        len(parsed.get("answer", "") or ""),
    )

    meta = AiSqlResponseMeta(
        provider=result.provider,
        model=result.model,
        latency_ms=result.latency_ms,
    )
    return QueryChatResponse(meta=meta, **parsed)
