from __future__ import annotations

from typing import Any, List, Tuple

from .anti_patterns import detect_anti_patterns
from .heuristics import evaluate_plan, rank_findings
from .llm import generate_llm_suggestions
from .llm.guardrails import guard_rewrite
from .models import AnalyzerOutput, Confidence, RewriteSuggestion
from .plan_parser import NormalizedNode, parse_explain_json


def _infer_missing_data(root: NormalizedNode) -> List[str]:
    missing: List[str] = []
    has_actual_rows = False
    stack = [root]
    while stack:
        node = stack.pop()
        if node.actual_rows is not None or node.actual_total_rows is not None:
            has_actual_rows = True
            break
        stack.extend(node.children)
    if not has_actual_rows:
        missing.append("actual_rows")
    return missing


def analyze(sql: str, explain_json: Any, llm_enabled: bool = False) -> AnalyzerOutput:
    root = parse_explain_json(explain_json)
    findings, suggested_indexes = evaluate_plan(root, sql)
    ranked_findings, primary = rank_findings(findings)

    anti_patterns = detect_anti_patterns(sql)
    missing_data = _infer_missing_data(root)

    confidence_score = 0.7
    if missing_data:
        confidence_score -= 0.1 * len(missing_data)
    confidence_score = max(0.3, min(0.95, confidence_score))

    confidence = Confidence(overall=confidence_score, missing_data=missing_data)

    suggested_rewrite = None
    suggested_rewrite_explanation = None
    plain_summary: List[str] = []
    llm_used = False

    if llm_enabled:
        llm_suggestion = generate_llm_suggestions(
            sql,
            ranked_findings,
            suggested_indexes,
            anti_patterns,
            primary,
        )
        llm_used = llm_suggestion.used
        plain_summary = llm_suggestion.summary
        if llm_suggestion.rewrite_sql:
            guard = guard_rewrite(llm_suggestion.rewrite_sql)
            if guard.allowed:
                rationale = "; ".join(llm_suggestion.notes) if llm_suggestion.notes else None
                suggested_rewrite = RewriteSuggestion(
                    title="Proposed rewrite",
                    sql=llm_suggestion.rewrite_sql,
                    rationale=rationale,
                    notes=llm_suggestion.notes,
                    confidence=llm_suggestion.confidence,
                )
            else:
                suggested_rewrite_explanation = guard.reason or "Rewrite blocked by guardrails."
        else:
            if llm_suggestion.error:
                suggested_rewrite_explanation = llm_suggestion.error
            elif llm_suggestion.notes:
                suggested_rewrite_explanation = llm_suggestion.notes[0]
    else:
        suggested_rewrite_explanation = "LLM disabled for current settings."

    return AnalyzerOutput(
        primary_bottleneck=primary,
        findings=ranked_findings,
        suggested_indexes=suggested_indexes,
        suggested_rewrite=suggested_rewrite,
        suggested_rewrite_explanation=suggested_rewrite_explanation,
        plain_summary=plain_summary,
        anti_patterns=anti_patterns,
        confidence=confidence,
        llm_used=llm_used,
    )
