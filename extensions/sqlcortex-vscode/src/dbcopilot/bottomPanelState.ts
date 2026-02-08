import type { DbCopilotMode } from "../state/dbCopilotState";

export type DbCopilotLogSource =
  | "orchestrator"
  | "performance"
  | "ddl"
  | "risk"
  | "governance"
  | "explainability";

export type DbCopilotLogEntry = {
  id: string;
  timestamp: string;
  source: DbCopilotLogSource;
  message: string;
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
};
