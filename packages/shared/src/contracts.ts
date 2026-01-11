export type ExplainMode = "EXPLAIN" | "EXPLAIN_ANALYZE";

export type AnalyzeRequest = {
  orgId: string;
  projectId: string;
  source: "vscode";
  explainMode: ExplainMode;
  sqlHash: string;
  connectionRef: string;
  clientContext: {
    extensionVersion: string;
    workspaceIdHash: string;
  };
};

export type AnalyzeResponse = {
  findings: string[];
  ai: string[];
  confidence: "low" | "medium" | "high";
  warnings: string[];
  metering: {
    eventId: string;
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
