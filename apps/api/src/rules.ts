import type { PlanSummary, RuleFinding } from "../../../packages/shared/src/contracts";

const LARGE_ROW_THRESHOLD = 10000;

type RuleEvaluationInput = {
  sqlTextInMemory: string;
  planSummary: PlanSummary;
};

type RuleEvaluationOutput = {
  findings: RuleFinding[];
};

function resolveRowCount(summary: PlanSummary): number | null {
  if (typeof summary.actualRows === "number" && Number.isFinite(summary.actualRows)) {
    return summary.actualRows;
  }
  if (typeof summary.planRows === "number" && Number.isFinite(summary.planRows)) {
    return summary.planRows;
  }
  return null;
}

function isLargeRowCount(summary: PlanSummary): boolean {
  const rows = resolveRowCount(summary);
  return rows !== null && rows >= LARGE_ROW_THRESHOLD;
}

function stripSqlComments(sqlText: string): string {
  const withoutBlock = sqlText.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlock.replace(/--.*$/gm, " ");
}

function hasSelectStar(sqlText: string): boolean {
  const cleaned = stripSqlComments(sqlText);
  return /\bselect\s+\*/i.test(cleaned);
}

export function evaluate(input: RuleEvaluationInput): RuleEvaluationOutput {
  const findings: RuleFinding[] = [];
  const { planSummary, sqlTextInMemory } = input;

  if (planSummary.hasSeqScan) {
    findings.push({
      code: "SEQ_SCAN_LARGE_TABLE",
      severity: "warn",
      message: "Sequential scan detected in the plan.",
      recommendation:
        "Review filters and join conditions; consider indexes on frequently filtered keys.",
      rationale: "Sequential scans can be expensive when the table grows or filters are selective.",
    });
  }

  if (planSummary.hasNestedLoop && isLargeRowCount(planSummary)) {
    findings.push({
      code: "NESTED_LOOP_LARGE_ROWS",
      severity: "high",
      message: "Nested loop join on large row counts.",
      recommendation:
        "Consider indexes on join keys or alternative join strategies to reduce row scans.",
      rationale: "Nested loops can degrade quickly when both sides return many rows.",
    });
  }

  if (planSummary.hasSort && isLargeRowCount(planSummary)) {
    findings.push({
      code: "SORT_LARGE_ROWS",
      severity: "warn",
      message: "Sort operation on a large result set.",
      recommendation:
        "Consider indexing for ORDER BY or adding LIMIT to reduce sort volume.",
      rationale: "Sorting many rows increases memory and I/O pressure.",
    });
  }

  if (planSummary.hasMisestimation) {
    findings.push({
      code: "CARDINALITY_MISESTIMATE",
      severity: "info",
      message: "Row estimates differ from actual rows.",
      recommendation:
        "Run ANALYZE and review statistics to improve planner estimates.",
      rationale: "Inaccurate estimates can lead to suboptimal plans.",
    });
  }

  if (sqlTextInMemory && hasSelectStar(sqlTextInMemory)) {
    findings.push({
      code: "SELECT_STAR",
      severity: "info",
      message: "SELECT * detected in query text.",
      recommendation:
        "Select only needed columns to reduce I/O and improve performance.",
      rationale: "Fetching unused columns increases transfer and memory usage.",
    });
  }

  return { findings };
}
