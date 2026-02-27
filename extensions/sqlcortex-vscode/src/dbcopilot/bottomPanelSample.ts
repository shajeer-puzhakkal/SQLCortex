import type { DbCopilotMode } from "../state/dbCopilotState";
import type {
  DbCopilotLogEntry,
  DbCopilotRiskImpactState,
  DbCopilotSqlPreviewState,
} from "./bottomPanelState";

export type DbCopilotPanelSample = {
  sqlPreview: DbCopilotSqlPreviewState;
  riskImpact: DbCopilotRiskImpactState;
  logs: DbCopilotLogEntry[];
};

export function createSampleDbCopilotPanel(mode: DbCopilotMode): DbCopilotPanelSample {
  const upSql = [
    "CREATE INDEX CONCURRENTLY idx_orders_status_created_at_partial",
    "  ON public.orders (status, created_at)",
    "  WHERE status IN ('pending','paid');",
  ].join("\n");

  const downSql = "DROP INDEX IF EXISTS idx_orders_status_created_at_partial;";

  const sqlPreview: DbCopilotSqlPreviewState = {
    upSql,
    downSql,
    mode,
    policyAllowsExecution: true,
    policyReason: null,
  };

  const riskImpact: DbCopilotRiskImpactState = {
    requiresManualReview: false,
    summary: [
      { label: "Breaking changes", value: "None" },
      { label: "Lock contention risk", value: "Low (CONCURRENTLY used)" },
      { label: "Migration window friendly", value: "Yes" },
      { label: "Data loss risk", value: "None" },
      { label: "Mitigations", value: "Already applied" },
      { label: "Policy", value: "Compliant" },
    ],
    sections: [
      { title: "Risk Level", value: "LOW (18/100)" },
      { title: "Impacted Objects", value: "0 impacted, 0 broken" },
      { title: "Lock Behavior", value: "SHARE UPDATE EXCLUSIVE (LOW)" },
      { title: "Rows Affected", value: "0" },
      { title: "Safer Strategy", value: "Original plan acceptable" },
      { title: "Rollback Plan", value: "1 statement(s), 0 warning(s)" },
      { title: "Confidence Score", value: "92% (HIGH)" },
    ],
    actions: {
      canProceed: true,
      canApplySaferPlan: false,
      saferPlanReason: "Safer strategy is not required for this migration.",
    },
  };

  const logs: DbCopilotLogEntry[] = [
    createLog("orchestrator", "Detected intent optimize_query", "09:31:02"),
    createLog("performance", "Parsed EXPLAIN plan (bitmap heap scan)", "09:31:02"),
    createLog("governance", "Enforcing concurrent index policy (pg)", "09:31:03"),
    createLog("ddl", "Generated up/down migration id=20260205_093105", "09:31:05"),
  ];

  return { sqlPreview, riskImpact, logs };
}

function createLog(
  source: DbCopilotLogEntry["source"],
  message: string,
  timestamp: string
): DbCopilotLogEntry {
  return {
    id: `${timestamp}-${source}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp,
    source,
    message,
  };
}
