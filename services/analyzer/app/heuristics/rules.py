from __future__ import annotations

import re
from typing import Iterable, List, Optional, Tuple

from ..models import Finding, IndexSuggestion
from ..plan_parser import NormalizedNode

SEQ_SCAN_ROW_THRESHOLD = 50000
NESTED_LOOP_OUTER_THRESHOLD = 50000
MIS_ESTIMATE_RATIO = 10.0
WIDE_ROW_WIDTH = 200
SORT_SPILL_TEMP_BLOCKS = 1


def walk_plan(node: NormalizedNode, prefix: Optional[List[str]] = None):
    path = list(prefix or [])
    path.append(node.node_type)
    yield node, path
    for child in node.children:
        yield from walk_plan(child, path)


def _severity_from_score(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"


def _extract_condition_columns(condition: Optional[str]) -> List[str]:
    if not condition:
        return []
    columns: List[str] = []
    pattern = re.compile(
        r"\b([a-zA-Z_][\w\.]*?)\b\s*(=|>=|<=|<>|!=|>|<|LIKE|ILIKE|IN|ANY|\bIS\b)"
    )
    for match in pattern.finditer(condition):
        column = match.group(1)
        if column.upper() in {"TRUE", "FALSE", "NULL"}:
            continue
        columns.append(column.split(".")[-1])
    return columns


def _index_name(table: str, columns: List[str]) -> str:
    safe_table = re.sub(r"[^a-z0-9_]+", "_", table.lower())
    safe_cols = "_".join(re.sub(r"[^a-z0-9_]+", "_", c.lower()) for c in columns)
    return f"idx_{safe_table}_{safe_cols or 'cols'}"


def _make_index_suggestion(table: str, columns: List[str], reason: str) -> IndexSuggestion:
    return IndexSuggestion(
        table=table,
        columns=columns,
        sql=f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_index_name(table, columns)} ON {table} ({', '.join(columns)});",
        reason=reason,
    )


def _seq_scan_findings(
    node: NormalizedNode, path: List[str]
) -> Tuple[Optional[Finding], Optional[IndexSuggestion]]:
    node_type = node.node_type.lower()
    if "seq scan" not in node_type:
        return None, None

    rows = node.actual_total_rows or node.plan_rows or 0
    if rows < SEQ_SCAN_ROW_THRESHOLD:
        return None, None

    table = node.relation_name or node.alias or "table"
    score = min(1.0, rows / (SEQ_SCAN_ROW_THRESHOLD * 4))
    severity = _severity_from_score(score)
    finding = Finding(
        code="SEQ_SCAN_LARGE",
        title=f"Sequential scan on {table}",
        severity=severity,
        score=score,
        impact=f"Reads ~{rows} rows via sequential scan.",
        remediation="Add a selective index or tighten WHERE clause.",
        evidence={"rows": rows, "path": " > ".join(path)},
    )

    columns = _extract_condition_columns(node.filter) or _extract_condition_columns(node.index_cond)
    suggestion = None
    if columns and node.relation_name:
        suggestion = _make_index_suggestion(
            node.relation_name,
            list(dict.fromkeys(columns)),
            "Accelerate the scan with an index covering filter columns.",
        )
    return finding, suggestion


def _nested_loop_findings(node: NormalizedNode, path: List[str]) -> Optional[Finding]:
    if node.node_type.lower() != "nested loop" or len(node.children) < 2:
        return None

    outer = node.children[0]
    outer_rows = outer.actual_total_rows or outer.plan_rows or 0
    if outer_rows < NESTED_LOOP_OUTER_THRESHOLD:
        return None

    inner = node.children[1]
    inner_scan = inner.node_type.lower()
    score = min(1.0, outer_rows / (NESTED_LOOP_OUTER_THRESHOLD * 3))
    severity = _severity_from_score(score)
    finding = Finding(
        code="NESTED_LOOP_HUGE_OUTER",
        title="Nested loop with very large outer side",
        severity=severity,
        score=score,
        impact=f"Outer side produces ~{outer_rows} rows; nested loop likely multiplies cost.",
        remediation="Consider hash/merge join, indexes on join keys, or reducing outer rows.",
        evidence={
            "outer_rows": outer_rows,
            "inner_type": inner_scan,
            "path": " > ".join(path),
        },
    )
    return finding


def _sort_spill_findings(node: NormalizedNode, path: List[str]) -> Optional[Finding]:
    node_type = node.node_type.lower()
    if "sort" not in node_type:
        return None

    buffers = node.buffers or {}
    temp_reads = buffers.get("Temp Read Blocks") or 0
    temp_written = buffers.get("Temp Written Blocks") or 0
    used_disk = False
    if node.sort_space_type:
        used_disk = str(node.sort_space_type).lower() in {"disk", "external"}
    if node.sort_method:
        used_disk = used_disk or ("disk" in node.sort_method.lower())
    if temp_reads or temp_written:
        used_disk = True

    if not used_disk:
        return None

    score = 0.65
    severity = _severity_from_score(score)
    finding = Finding(
        code="SORT_SPILL",
        title="Sort spilled to disk",
        severity=severity,
        score=score,
        impact="External sort likely spilled to disk, increasing I/O.",
        remediation="Reduce sort width, add indexes to satisfy ORDER BY, or increase work_mem.",
        evidence={
            "sort_method": node.sort_method,
            "sort_space_type": node.sort_space_type,
            "temp_read_blocks": temp_reads,
            "temp_written_blocks": temp_written,
            "path": " > ".join(path),
        },
    )
    return finding


def _misestimate_findings(node: NormalizedNode, path: List[str]) -> Optional[Finding]:
    if node.plan_rows is None or node.actual_total_rows is None:
        return None

    plan_rows = max(1, node.plan_rows)
    actual_rows = max(1, node.actual_total_rows)
    ratio = actual_rows / plan_rows
    if ratio < MIS_ESTIMATE_RATIO and (1 / ratio) < MIS_ESTIMATE_RATIO:
        return None

    score = min(1.0, max(ratio, 1 / ratio) / (MIS_ESTIMATE_RATIO * 3))
    severity = _severity_from_score(score)
    finding = Finding(
        code="ROW_MISESTIMATE",
        title="Row count mis-estimation",
        severity=severity,
        score=score,
        impact=f"Planner expected ~{plan_rows} rows but saw ~{actual_rows}.",
        remediation="Refresh statistics or add more selective filters/indexes.",
        evidence={"plan_rows": plan_rows, "actual_rows": actual_rows, "path": " > ".join(path)},
    )
    return finding


def _missing_index_findings(
    node: NormalizedNode, path: List[str]
) -> Tuple[Optional[Finding], Optional[IndexSuggestion]]:
    if "seq scan" not in node.node_type.lower():
        return None, None

    if node.index_cond:
        return None, None

    rows = node.actual_total_rows or node.plan_rows or 0
    if rows < SEQ_SCAN_ROW_THRESHOLD:
        return None, None

    if not node.filter:
        return None, None

    columns = _extract_condition_columns(node.filter)
    if not columns:
        return None, None

    table = node.relation_name or node.alias or "table"
    score = 0.75
    severity = _severity_from_score(score)
    finding = Finding(
        code="MISSING_INDEX",
        title=f"Possible missing index on {table}",
        severity=severity,
        score=score,
        impact=f"Filter executes as sequential scan on ~{rows} rows.",
        remediation="Create an index on frequently filtered columns.",
        evidence={"filter": node.filter, "path": " > ".join(path)},
    )
    suggestion = None
    if node.relation_name:
        suggestion = _make_index_suggestion(
            node.relation_name,
            list(dict.fromkeys(columns)),
            "Cover filter columns to avoid full table scan.",
        )
    return finding, suggestion


def _wide_row_findings(node: NormalizedNode, path: List[str]) -> Optional[Finding]:
    if node.plan_width is None or node.plan_width < WIDE_ROW_WIDTH:
        return None
    rows = node.actual_total_rows or node.plan_rows or 0
    if rows < SEQ_SCAN_ROW_THRESHOLD / 5:
        return None
    score = 0.45
    severity = _severity_from_score(score)
    return Finding(
        code="WIDE_ROW_FETCH",
        title="Wide rows fetched",
        severity=severity,
        score=score,
        impact=f"Plan width ~{node.plan_width} bytes across ~{rows} rows.",
        remediation="Select only needed columns or add narrower covering index.",
        evidence={"plan_width": node.plan_width, "rows": rows, "path": " > ".join(path)},
    )


def evaluate_plan(root: NormalizedNode, sql: str) -> Tuple[List[Finding], List[IndexSuggestion]]:
    findings: List[Finding] = []
    index_suggestions: List[IndexSuggestion] = []

    for node, path in walk_plan(root):
        seq_finding, seq_index = _seq_scan_findings(node, path)
        if seq_finding:
            findings.append(seq_finding)
        if seq_index:
            index_suggestions.append(seq_index)

        nested = _nested_loop_findings(node, path)
        if nested:
            findings.append(nested)

        spill = _sort_spill_findings(node, path)
        if spill:
            findings.append(spill)

        misestimate = _misestimate_findings(node, path)
        if misestimate:
            findings.append(misestimate)

        missing_idx, idx_suggestion = _missing_index_findings(node, path)
        if missing_idx:
            findings.append(missing_idx)
        if idx_suggestion:
            index_suggestions.append(idx_suggestion)

        wide = _wide_row_findings(node, path)
        if wide:
            findings.append(wide)

    # Deduplicate index suggestions by table+columns
    seen = set()
    deduped_indexes: List[IndexSuggestion] = []
    for suggestion in index_suggestions:
        key = (suggestion.table, tuple(suggestion.columns))
        if key in seen:
            continue
        seen.add(key)
        deduped_indexes.append(suggestion)

    return findings, deduped_indexes
