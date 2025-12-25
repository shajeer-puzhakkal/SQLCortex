from __future__ import annotations

from typing import Any, List, Tuple

from .anti_patterns import detect_anti_patterns
from .heuristics import evaluate_plan, rank_findings
from .models import AnalyzerOutput, Confidence
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


def analyze(sql: str, explain_json: Any) -> AnalyzerOutput:
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

    return AnalyzerOutput(
        primary_bottleneck=primary,
        findings=ranked_findings,
        suggested_indexes=suggested_indexes,
        suggested_rewrite=None,
        anti_patterns=anti_patterns,
        confidence=confidence,
    )
