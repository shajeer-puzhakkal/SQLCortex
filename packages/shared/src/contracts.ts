export type ExplainMode = "EXPLAIN" | "EXPLAIN_ANALYZE";

export type AnalyzeRequest = {
  orgId: string;
  projectId: string;
  source: "vscode";
  explainMode: ExplainMode;
  allowAnalyze?: boolean;
  sql: string;
  sqlHash: string;
  connectionRef: string;
  clientContext: {
    extensionVersion: string;
    workspaceIdHash: string;
  };
};

export type PlanSummary = {
  totalCost: number | null;
  planRows: number | null;
  actualRows: number | null;
  nodeTypes: string[];
  hasSeqScan: boolean;
  hasNestedLoop: boolean;
  hasSort: boolean;
  hasHashJoin: boolean;
  hasBitmapHeapScan: boolean;
  hasMisestimation: boolean;
};

export type RuleFinding = {
  code: string;
  severity: "info" | "warn" | "high";
  message: string;
  recommendation: string;
  rationale: string;
};

export type AiSuggestion = {
  title: string;
  description: string;
  confidence: "low" | "medium" | "high";
  tradeoffs: string[];
};

export type AiInsight = {
  explanation: string;
  suggestions: AiSuggestion[];
  warnings: string[];
  assumptions: string[];
};

export type AnalyzeResponse = {
  planSummary: PlanSummary;
  findings: RuleFinding[];
  ai: AiInsight | null;
  warnings: string[];
  metering: {
    eventId: string | null;
    aiUsed: boolean;
    tokensEstimated: number | null;
  };
};

export type MeterEvent = {
  id: string;
  timestamp: string;
  orgId: string | null;
  projectId: string | null;
  userId: string | null;
  source: "vscode";
  eventType: "query_analysis" | "ai_explain" | "ai_suggest" | "reanalyze";
  aiUsed: boolean;
  model?: string | null;
  tokensEstimated?: number | null;
  sqlHash: string;
  durationMs: number;
  status: "success" | "error";
  errorCode?: string | null;
  explainMode?: ExplainMode | null;
};

export type DashboardMetricsResponse = {
  periodStart: string;
  periodEnd: string;
  analyses: number;
  aiCalls: number;
  tokensEstimated: number | null;
};
