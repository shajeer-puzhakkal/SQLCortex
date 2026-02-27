import type { DbCopilotMode } from "../state/dbCopilotState";

export type DbCopilotLogSource =
  | "orchestrator"
  | "schema_analyst"
  | "performance"
  | "ddl"
  | "procedure"
  | "risk"
  | "governance"
  | "explainability"
  | "execution";

export type DbCopilotLogEntry = {
  id: string;
  timestamp: string;
  source: DbCopilotLogSource;
  message: string;
};

export type DbCopilotAuditLogEntry = {
  id: string;
  timestamp: string;
  agent: DbCopilotLogSource;
  message: string;
  input_redacted: unknown;
  output_redacted: unknown;
  input_hash: string;
  output_hash: string;
  tokens_estimate: {
    input: number;
    output: number;
    total: number;
  };
  credits_estimate: number;
  duration_ms: number;
  meter: {
    ai_tokens_in: number;
    ai_tokens_out: number;
    ai_cost_estimate_usd: number;
    credits_used: number;
  };
  session_id: string;
};

export type DbCopilotSqlPreviewState = {
  upSql: string;
  downSql: string;
  mode: DbCopilotMode;
  policyAllowsExecution: boolean;
  policyReason?: string | null;
};

export type DbCopilotRiskImpactState = {
  requiresManualReview: boolean;
  requiresManualReviewReason?: string | null;
  summary: Array<{ label: string; value: string }>;
  sections?: DbCopilotRiskImpactSection[];
  actions?: DbCopilotRiskImpactActions;
};

export type DbCopilotRiskImpactSection = {
  title: string;
  value: string;
  details?: string[];
};

export type DbCopilotRiskImpactActions = {
  canProceed: boolean;
  proceedReason?: string | null;
  canApplySaferPlan: boolean;
  saferPlanReason?: string | null;
  saferPlanApplied?: boolean;
};
