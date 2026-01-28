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
  schemaSummary?: {
    schemaName: string;
    stats: {
      tableCount: number;
      viewCount: number;
      columnCount: number;
      foreignKeyCount: number;
      indexCount: number;
    };
    findingsCount?: number;
    suggestionsCount?: number;
  };
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

export type AiUsageState = {
  level: "normal" | "warning" | "critical" | "blocked";
  creditsRemaining?: number;
  dailyCredits?: number;
};

export type AnalyzeResponse = {
  status: "ok" | "gated";
  gateReason?: "PLAN_LIMIT" | "AI_DISABLED" | "CREDITS_EXHAUSTED";
  requiredPlan?: string | null;
  upgradeUrl?: string | null;
  planSummary: PlanSummary;
  findings: RuleFinding[];
  ai: AiInsight | null;
  explainJson?: unknown;
  warnings: string[];
  metering: {
    eventId: string | null;
    aiUsed: boolean;
    tokensEstimated: number | null;
  };
};

export type SchemaInsightsStats = {
  tableCount: number;
  viewCount: number;
  columnCount: number;
  foreignKeyCount: number;
  indexCount: number;
};

export type SchemaInsightsRequest = {
  projectId: string;
  schemaName: string;
  stats: SchemaInsightsStats;
  findings: string[];
  suggestions: string[];
  source: "vscode";
  userIntent?: string | null;
};

export type SchemaInsightsResponse = {
  status: "ok" | "gated";
  gateReason?: "PLAN_LIMIT" | "AI_DISABLED" | "CREDITS_EXHAUSTED";
  requiredPlan?: string | null;
  upgradeUrl?: string | null;
  ai: AiInsight | null;
  warnings: string[];
  assumptions: string[];
  metering: {
    eventId: string | null;
    aiUsed: boolean;
    tokensEstimated: number | null;
  };
};

export type QueryChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type QueryChatRequest = {
  projectId: string;
  connectionId: string;
  sql: string;
  explainJson: unknown;
  messages: QueryChatMessage[];
  source: "vscode";
};

export type QueryChatResponse = {
  status: "ok" | "gated";
  gateReason?: "PLAN_LIMIT" | "AI_DISABLED" | "CREDITS_EXHAUSTED";
  requiredPlan?: string | null;
  upgradeUrl?: string | null;
  answer: string;
  warnings: string[];
  metering: {
    eventId: string | null;
    aiUsed: boolean;
    tokensEstimated: number | null;
  };
};

export type PlanUsageSummary = {
  planId: string;
  planName: string;
  aiEnabled: boolean;
  monthlyAiActionsLimit: number | null;
  usedAiActionsThisPeriod: number;
  periodStart: string;
  periodEnd: string;
  upgradeAvailable: boolean;
  creditSystemEnabled: boolean;
  dailyCredits: number | null;
  creditsRemaining: number | null;
  graceUsed: boolean | null;
  softLimit70Reached: boolean;
  softLimit90Reached: boolean;
  aiUsageState: AiUsageState;
};

export type BillingCreditsResponse = {
  dailyCredits: number;
  creditsRemaining: number;
  graceUsed: boolean;
  lastResetAt: string;
  softLimit70Reached: boolean;
  softLimit90Reached: boolean;
  notice?: string | null;
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

export type DashboardUsageResponse = {
  periodStart: string;
  periodEnd: string;
  totalActions: number;
  aiActions: number;
  ruleActions: number;
  byAction: Array<{ action: string; count: number }>;
  timeline: Array<{ date: string; total: number; ai: number; rules: number }>;
  valueMeter: { minutesSaved: number; costSavedUsd: number };
};
