import type { PlanNodeSummary, PlanSummary } from "../types";

type PlanNode = Record<string, unknown>;

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNodeType(node: PlanNode): string | null {
  const value = node["Node Type"] ?? node["Operation"];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlanNode(value: unknown): value is PlanNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const node = value as PlanNode;
  return (
    typeof node["Node Type"] === "string" ||
    typeof node["Operation"] === "string" ||
    Array.isArray(node["Plans"])
  );
}

function unwrapExplainPayload(explainJson: unknown): unknown {
  if (!explainJson || typeof explainJson !== "object" || Array.isArray(explainJson)) {
    return explainJson;
  }
  const record = explainJson as PlanNode;
  if ("QUERY PLAN" in record) {
    return record["QUERY PLAN"];
  }
  if ("QUERY_PLAN" in record) {
    return record["QUERY_PLAN"];
  }
  return explainJson;
}

function extractPlanRoots(explainJson: unknown): PlanNode[] {
  const payload = unwrapExplainPayload(explainJson);
  if (Array.isArray(payload)) {
    const roots: PlanNode[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const plan = (entry as PlanNode)["Plan"];
      if (isPlanNode(plan)) {
        roots.push(plan);
        continue;
      }
      if (isPlanNode(entry)) {
        roots.push(entry);
      }
    }
    return roots;
  }

  if (isPlanNode(payload)) {
    const nestedPlan = (payload as PlanNode)["Plan"];
    if (isPlanNode(nestedPlan)) {
      return [nestedPlan];
    }
    return [payload];
  }

  return [];
}

function buildNodeSummary(nodeTypeCounts: Map<string, number>): PlanNodeSummary[] {
  return Array.from(nodeTypeCounts.entries())
    .map(([nodeType, count]) => ({ node_type: nodeType, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.node_type.localeCompare(right.node_type);
    });
}

export function parsePlan(explainJson: unknown): PlanSummary {
  const roots = extractPlanRoots(explainJson);
  if (roots.length === 0) {
    throw new Error("EXPLAIN JSON missing Plan node");
  }

  let hasSeqScan = false;
  let hasHashJoin = false;
  let hasSort = false;
  let hasNestedLoop = false;
  const nodeTypeCounts = new Map<string, number>();

  const visit = (node: PlanNode): void => {
    const nodeType = readNodeType(node);
    if (nodeType) {
      const normalizedNodeType = nodeType.toLowerCase();
      nodeTypeCounts.set(nodeType, (nodeTypeCounts.get(nodeType) ?? 0) + 1);
      if (normalizedNodeType === "seq scan") {
        hasSeqScan = true;
      } else if (normalizedNodeType === "hash join") {
        hasHashJoin = true;
      } else if (normalizedNodeType === "sort") {
        hasSort = true;
      } else if (normalizedNodeType === "nested loop") {
        hasNestedLoop = true;
      }
    }

    const children = node["Plans"];
    if (!Array.isArray(children)) {
      return;
    }
    for (const child of children) {
      if (isPlanNode(child)) {
        visit(child);
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  const primaryRoot = roots[0]!;
  return {
    total_cost: readNumber(primaryRoot["Total Cost"]),
    plan_rows: readNumber(primaryRoot["Plan Rows"]),
    plan_width: readNumber(primaryRoot["Plan Width"]),
    node_summary: buildNodeSummary(nodeTypeCounts),
    has_seq_scan: hasSeqScan,
    has_hash_join: hasHashJoin,
    has_sort: hasSort,
    has_nested_loop: hasNestedLoop,
  };
}
