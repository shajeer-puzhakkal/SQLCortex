from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
import logging

from .ai_response_parser import parse_insights_response, parse_planner_response
from .models import AiInsightsRequest, AiInsightsResponse, AiSqlResponseMeta
from .prompts import render_insights_planner_prompt, render_insights_prompt
from .providers.errors import ProviderResponseError, ProviderTimeoutError, ProviderUnavailableError
from .providers.router import route_generate_text

router = APIRouter(prefix="/ai", tags=["ai"])

_SYSTEM_PROMPT = (
    "You are a SQL performance assistant. Return only valid JSON that matches the schema."
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

logger = logging.getLogger(__name__)


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


def _policy_gating_enabled() -> bool:
    raw = (os.getenv("AI_POLICY_GATING") or "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _run_planner(payload: AiInsightsRequest) -> PlannerPolicy:
    prompt = render_insights_planner_prompt(
        plan_summary=payload.plan_summary,
        rule_findings=payload.rule_findings,
        user_intent=payload.user_intent,
    )
    logger.info("AI insights planner prompt length: %s", len(prompt))
    try:
        result = route_generate_text(_PLANNER_SYSTEM_PROMPT, prompt)
        parsed = parse_planner_response(result.text)
    except Exception as exc:
        logger.warning("AI planner failed, using defaults: %s", exc)
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


def _has_plan_flag(plan_summary: Dict[str, Any], key: str) -> bool:
    value = plan_summary.get(key)
    return bool(value) if isinstance(value, bool) else False


def _plan_actual_rows_missing(plan_summary: Dict[str, Any]) -> bool:
    return plan_summary.get("actualRows") is None


def _filter_warnings(warnings: List[str], plan_summary: Dict[str, Any]) -> List[str]:
    if not warnings:
        return []
    allowed: List[str] = []
    actual_rows_missing = _plan_actual_rows_missing(plan_summary)
    has_misestimation = _has_plan_flag(plan_summary, "hasMisestimation")
    has_seq_scan = _has_plan_flag(plan_summary, "hasSeqScan")
    has_nested_loop = _has_plan_flag(plan_summary, "hasNestedLoop")
    has_sort = _has_plan_flag(plan_summary, "hasSort")

    for warning in warnings:
        lowered = warning.lower()
        if ("estimate" in lowered or "actual row" in lowered) and actual_rows_missing:
            allowed.append(warning)
            continue
        if "misestimate" in lowered and has_misestimation:
            allowed.append(warning)
            continue
        if "seq scan" in lowered and has_seq_scan:
            allowed.append(warning)
            continue
        if "nested loop" in lowered and has_nested_loop:
            allowed.append(warning)
            continue
        if "sort" in lowered and has_sort:
            allowed.append(warning)
            continue

    return allowed


def _filter_assumptions(items: List[str]) -> List[str]:
    if not items:
        return []
    filtered: List[str] = []
    for item in items:
        lowered = item.lower()
        if any(keyword in lowered for keyword in DISALLOWED_SCHEMA_KEYWORDS):
            continue
        filtered.append(item)
    return filtered


def _suggestion_text(suggestion: Dict[str, Any]) -> str:
    parts: List[str] = []
    title = suggestion.get("title")
    description = suggestion.get("description")
    tradeoffs = suggestion.get("tradeoffs")
    if isinstance(title, str):
        parts.append(title)
    if isinstance(description, str):
        parts.append(description)
    if isinstance(tradeoffs, list):
        parts.extend([item for item in tradeoffs if isinstance(item, str)])
    return " ".join(parts).lower()


def _filter_suggestions(suggestions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not suggestions:
        return []
    filtered: List[Dict[str, Any]] = []
    for suggestion in suggestions:
        if not isinstance(suggestion, dict):
            continue
        text = _suggestion_text(suggestion)
        if any(keyword in text for keyword in HARDBLOCK_FK_KEYWORDS):
            continue
        if any(keyword in text for keyword in DISALLOWED_SCHEMA_KEYWORDS):
            continue
        filtered.append(suggestion)
    return filtered


def _apply_policy(
    parsed: Dict[str, Any],
    plan_summary: Dict[str, Any],
    policy: PlannerPolicy,
) -> Dict[str, Any]:
    suggestions = parsed.get("suggestions", [])
    warnings = parsed.get("warnings", [])
    assumptions = parsed.get("assumptions", [])

    if not policy.allow_schema_advice:
        assumptions = []
        if isinstance(suggestions, list):
            suggestions = _filter_suggestions(suggestions)
    elif not policy.allow_fk_recommendations:
        if isinstance(suggestions, list):
            suggestions = _filter_suggestions(suggestions)
    elif isinstance(suggestions, list):
        suggestions = _filter_suggestions(suggestions)

    if isinstance(assumptions, list):
        assumptions = _filter_assumptions(assumptions)

    if isinstance(warnings, list):
        warnings = _filter_warnings(warnings, plan_summary)

    parsed["suggestions"] = suggestions
    parsed["warnings"] = warnings
    parsed["assumptions"] = assumptions
    return parsed


def _handle_request(payload: AiInsightsRequest) -> AiInsightsResponse:
    logger.info(
        "AI insights request: plan_summary_keys=%s rule_findings=%s user_intent=%s",
        list(payload.plan_summary.keys()) if isinstance(payload.plan_summary, dict) else None,
        len(payload.rule_findings) if payload.rule_findings else 0,
        "yes" if payload.user_intent else "no",
    )
    if isinstance(payload.plan_summary, dict):
        logger.info(
            "AI insights plan summary: actualRows=%s planRows=%s nodeTypes=%s hasSeqScan=%s hasNestedLoop=%s hasSort=%s hasMisestimation=%s",
            payload.plan_summary.get("actualRows"),
            payload.plan_summary.get("planRows"),
            len(payload.plan_summary.get("nodeTypes") or []),
            payload.plan_summary.get("hasSeqScan"),
            payload.plan_summary.get("hasNestedLoop"),
            payload.plan_summary.get("hasSort"),
            payload.plan_summary.get("hasMisestimation"),
        )
    policy = DEFAULT_POLICY
    if _policy_gating_enabled():
        policy = _run_planner(payload)
    logger.info(
        "AI insights policy: allow_schema=%s allow_fk=%s flags=%s",
        policy.allow_schema_advice,
        policy.allow_fk_recommendations,
        policy.policy_flags,
    )
    user_prompt = render_insights_prompt(
        plan_summary=payload.plan_summary,
        rule_findings=payload.rule_findings,
        user_intent=payload.user_intent,
        policy_flags=policy.policy_flags,
        allowed_reco_types=ALLOWED_RECO_TYPES,
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

    if _policy_gating_enabled() and isinstance(payload.plan_summary, dict):
        before_suggestions = len(parsed.get("suggestions", []) or [])
        before_warnings = len(parsed.get("warnings", []) or [])
        before_assumptions = len(parsed.get("assumptions", []) or [])
        parsed = _apply_policy(parsed, payload.plan_summary, policy)
        after_suggestions = len(parsed.get("suggestions", []) or [])
        after_warnings = len(parsed.get("warnings", []) or [])
        after_assumptions = len(parsed.get("assumptions", []) or [])
        if before_suggestions != after_suggestions or before_warnings != after_warnings:
            logger.info(
                "AI insights policy filtered: suggestions %s->%s warnings %s->%s assumptions %s->%s",
                before_suggestions,
                after_suggestions,
                before_warnings,
                after_warnings,
                before_assumptions,
                after_assumptions,
            )

    meta = AiSqlResponseMeta(
        provider=result.provider,
        model=result.model,
        latency_ms=result.latency_ms,
    )
    logger.info(
        "AI insights response: provider=%s model=%s latency_ms=%s suggestions=%s warnings=%s assumptions=%s",
        result.provider,
        result.model,
        result.latency_ms,
        len(parsed.get("suggestions", []) or []),
        len(parsed.get("warnings", []) or []),
        len(parsed.get("assumptions", []) or []),
    )
    return AiInsightsResponse(meta=meta, **parsed)


@router.post("/insights", response_model=AiInsightsResponse)
def insights(payload: AiInsightsRequest) -> AiInsightsResponse:
    return _handle_request(payload)
