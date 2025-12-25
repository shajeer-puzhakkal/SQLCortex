from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class NormalizedNode(BaseModel):
    node_type: str
    relation_name: Optional[str] = None
    schema: Optional[str] = None
    alias: Optional[str] = None
    startup_cost: Optional[float] = None
    total_cost: Optional[float] = None
    plan_rows: Optional[int] = None
    plan_width: Optional[int] = None
    actual_startup_time: Optional[float] = None
    actual_total_time: Optional[float] = None
    actual_rows: Optional[int] = None
    actual_loops: Optional[int] = None
    actual_total_rows: Optional[int] = None
    filter: Optional[str] = None
    index_cond: Optional[str] = None
    hash_cond: Optional[str] = None
    merge_cond: Optional[str] = None
    join_filter: Optional[str] = None
    sort_key: Optional[List[str]] = None
    group_key: Optional[List[str]] = None
    sort_method: Optional[str] = None
    sort_space_used: Optional[float] = None
    sort_space_type: Optional[str] = None
    buffers: Optional[Dict[str, Any]] = None
    output: Optional[List[str]] = None
    children: List["NormalizedNode"] = Field(default_factory=list)
    extra: Dict[str, Any] = Field(default_factory=dict)

    model_config = {"arbitrary_types_allowed": True}


def _extract_known_fields(plan: Dict[str, Any]) -> Dict[str, Any]:
    def _get_float(key: str) -> Optional[float]:
        value = plan.get(key)
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _get_int(key: str) -> Optional[int]:
        value = plan.get(key)
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    buffers: Dict[str, Any] = {}
    for key, value in plan.items():
        if "Blocks" in key or "I/O" in key or key.startswith("Temp "):
            buffers[key] = value

    fields: Dict[str, Any] = {
        "node_type": plan.get("Node Type") or plan.get("Operation") or "Unknown",
        "relation_name": plan.get("Relation Name") or plan.get("Table Name"),
        "schema": plan.get("Schema"),
        "alias": plan.get("Alias"),
        "startup_cost": _get_float("Startup Cost"),
        "total_cost": _get_float("Total Cost"),
        "plan_rows": _get_int("Plan Rows"),
        "plan_width": _get_int("Plan Width"),
        "actual_startup_time": _get_float("Actual Startup Time"),
        "actual_total_time": _get_float("Actual Total Time"),
        "actual_rows": _get_int("Actual Rows"),
        "actual_loops": _get_int("Actual Loops"),
        "filter": plan.get("Filter"),
        "index_cond": plan.get("Index Cond"),
        "hash_cond": plan.get("Hash Cond"),
        "merge_cond": plan.get("Merge Cond"),
        "join_filter": plan.get("Join Filter"),
        "sort_key": plan.get("Sort Key"),
        "group_key": plan.get("Group Key"),
        "sort_method": plan.get("Sort Method"),
        "sort_space_used": _get_float("Sort Space Used"),
        "sort_space_type": plan.get("Sort Space Type"),
        "output": plan.get("Output"),
    }

    actual_rows = fields["actual_rows"]
    actual_loops = fields["actual_loops"] if fields["actual_loops"] is not None else 1
    if actual_rows is not None:
        total_rows = actual_rows * max(1, actual_loops)
        fields["actual_total_rows"] = total_rows

    if buffers:
        fields["buffers"] = buffers

    return fields


def _normalize_plan(
    plan: Dict[str, Any],
    *,
    max_depth: int,
    depth: int,
    node_budget: List[int],
) -> NormalizedNode:
    if depth > max_depth:
        raise ValueError(f"Plan depth exceeded limit of {max_depth}")

    node_budget[0] -= 1
    if node_budget[0] < 0:
        raise ValueError("Plan node count exceeded limit")

    children_raw = plan.get("Plans") or []
    children: List[NormalizedNode] = []
    for child in children_raw:
        if isinstance(child, dict):
            children.append(
                _normalize_plan(
                    child,
                    max_depth=max_depth,
                    depth=depth + 1,
                    node_budget=node_budget,
                )
            )

    fields = _extract_known_fields(plan)
    known_keys = {
        "Node Type",
        "Operation",
        "Relation Name",
        "Table Name",
        "Schema",
        "Alias",
        "Startup Cost",
        "Total Cost",
        "Plan Rows",
        "Plan Width",
        "Actual Startup Time",
        "Actual Total Time",
        "Actual Rows",
        "Actual Loops",
        "Filter",
        "Index Cond",
        "Hash Cond",
        "Merge Cond",
        "Join Filter",
        "Plans",
        "Sort Key",
        "Group Key",
        "Sort Method",
        "Sort Space Used",
        "Sort Space Type",
        "Output",
    }
    extra = {k: v for k, v in plan.items() if k not in known_keys}
    node = NormalizedNode(**fields, children=children, extra=extra)
    return node


def parse_explain_json(
    explain_json: Any,
    *,
    max_nodes: int = 50000,
    max_depth: int = 200,
) -> NormalizedNode:
    """
    Parse Postgres EXPLAIN (FORMAT JSON) output into a normalized tree.
    Supports both top-level array and object shapes.
    """
    node_budget = [max_nodes]

    def build_root(plan_obj: Dict[str, Any]) -> NormalizedNode:
        return _normalize_plan(plan_obj, max_depth=max_depth, depth=0, node_budget=node_budget)

    if isinstance(explain_json, list):
        if not explain_json:
            raise ValueError("EXPLAIN JSON array is empty")
        roots: List[NormalizedNode] = []
        meta: List[Dict[str, Any]] = []
        for entry in explain_json:
            if not isinstance(entry, dict) or "Plan" not in entry:
                raise ValueError("Invalid EXPLAIN JSON array entry")
            roots.append(build_root(entry["Plan"]))
            meta.append({k: v for k, v in entry.items() if k != "Plan"})

        if len(roots) == 1:
            if meta and meta[0]:
                # Attach metadata into extra to preserve details
                roots[0].extra["meta"] = meta[0]
            return roots[0]

        synthetic = NormalizedNode(
            node_type="Explain",
            relation_name=None,
            schema=None,
            alias=None,
            children=roots,
            extra={"meta": meta},
        )
        return synthetic

    if isinstance(explain_json, dict):
        if "Plan" not in explain_json:
            raise ValueError("Missing Plan key in EXPLAIN JSON")
        root = build_root(explain_json["Plan"])
        meta = {k: v for k, v in explain_json.items() if k != "Plan"}
        if meta:
            root.extra["meta"] = meta
        return root

    raise ValueError("EXPLAIN JSON must be an object or array")
