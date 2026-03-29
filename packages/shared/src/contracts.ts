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

export type IntelligenceMode = "fast" | "plan";

export type IntelligenceCostBucket = "Unknown" | "Low" | "Medium" | "High" | "Extreme";

export type IntelligenceRiskLevel = "Unknown" | "Pending" | "Safe" | "Warning" | "Dangerous";

export type IntelligenceRiskReason = {
  code: string;
  severity: "warn" | "high";
  message: string;
};

export type IntelligenceRiskGate = {
  can_execute: boolean;
  requires_confirmation: boolean;
  message: string;
};

export type IntelligenceComplexityRating = "Simple" | "Moderate" | "Complex";

export type IntelligencePerformanceLabel = "Excellent" | "Good" | "Needs Optimization" | "Risky";

export type IntelligenceReason = {
  code: string;
  severity: "info" | "warn" | "high";
  delta: number;
  message: string;
};

export type IntelligenceRecommendation = {
  code: string;
  message: string;
  confidence: number;
};

export type IntelligencePlanNodeSummary = {
  node_type: string;
  count: number;
};

export type IntelligencePlanSummary = {
  total_cost: number | null;
  plan_rows: number | null;
  plan_width: number | null;
  node_summary: IntelligencePlanNodeSummary[];
  has_seq_scan: boolean;
  has_hash_join: boolean;
  has_sort: boolean;
  has_nested_loop: boolean;
};

export type IntelligenceScoreRequest = {
  mode: IntelligenceMode;
  sql: string;
  project_id: string;
  connection_id?: string | null;
};

export type IntelligenceScoreResponse = {
  version: "v1";
  performance_score: number;
  performance_label: IntelligencePerformanceLabel;
  cost_bucket: IntelligenceCostBucket;
  risk_level: IntelligenceRiskLevel;
  complexity_rating: IntelligenceComplexityRating;
  reasons: IntelligenceReason[];
  recommendations: IntelligenceRecommendation[];
  risk_reasons?: IntelligenceRiskReason[];
  risk_gate?: IntelligenceRiskGate;
  plan_summary?: IntelligencePlanSummary;
};

export type IntelligenceHistoryEvent = {
  id: string;
  project_id: string;
  user_id: string | null;
  query_fingerprint: string;
  score: number;
  risk_level: IntelligenceRiskLevel;
  cost_bucket: IntelligenceCostBucket;
  complexity: IntelligenceComplexityRating;
  mode: IntelligenceMode;
  reasons_json: unknown;
  created_at: string;
};

export type IntelligenceHistoryResponse = {
  project_id: string;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  events: IntelligenceHistoryEvent[];
};

export type IntelligenceTopRiskyItem = {
  query_fingerprint: string;
  events_count: number;
  avg_score: number;
  min_score: number;
  risk_level: IntelligenceRiskLevel;
  cost_bucket: IntelligenceCostBucket;
  last_seen_at: string;
};

export type IntelligenceTopRiskyResponse = {
  project_id: string;
  range: "7d" | "30d";
  items: IntelligenceTopRiskyItem[];
};

export type IntelligenceTrendPoint = {
  date: string;
  events: number;
  avg_score: number | null;
  dangerous: number;
  warning: number;
  safe: number;
};

export type IntelligenceHeatmapCell = {
  day_of_week: number;
  hour_of_day: number;
  events: number;
};

export type IntelligenceTrendsResponse = {
  project_id: string;
  range: "7d" | "30d";
  points: IntelligenceTrendPoint[];
  risk_distribution: Array<{ risk_level: IntelligenceRiskLevel; count: number }>;
  cost_distribution: Array<{ cost_bucket: IntelligenceCostBucket; count: number }>;
  heatmap: IntelligenceHeatmapCell[];
};

export type ObservabilityMetricType = "table_stats" | "index_stats" | "query_stats";

export type ObservabilitySnapshotMetric = {
  metric_type: ObservabilityMetricType;
  source: "pg_stat_user_tables" | "pg_stat_user_indexes" | "pg_stat_statements";
  rows_collected: number;
  unavailable?: boolean;
};

export type ObservabilityCollectRequest = {
  project_id: string;
  connection_id: string;
};

export type ObservabilityCollectResponse = {
  project_id: string;
  connection_id: string;
  snapshot_time: string;
  inserted_count: number;
  metrics: ObservabilitySnapshotMetric[];
};

export type SchemaSnapshotCaptureRequest = {
  project_id: string;
  connection_id: string;
};

export type SchemaSnapshotCaptureResponse = {
  project_id: string;
  connection_id: string;
  snapshot_time: string;
  schema_hash: string;
  inserted_count: number;
  object_counts: {
    tables: number;
    columns: number;
    indexes: number;
    constraints: number;
    foreign_keys: number;
  };
};

export type SchemaTimelineRange = "7d" | "30d";

export type SchemaTimelineChange = {
  change_type: string;
  object_name: string;
  detected_at: string;
  risk_level: "low" | "medium" | "high";
  recommendation: string;
};

export type SchemaTimelineTableGrowth = {
  snapshot_time: string;
  table_name: string;
  rows_inserted_delta: number;
  rows_updated_delta: number;
  rows_deleted_delta: number;
  net_growth_rows: number;
};

export type SchemaTimelinePoint = {
  date: string;
  schema_changes: number;
  index_changes: number;
  table_growth_rows: number;
};

export type SchemaTimelineResponse = {
  project_id: string;
  range: SchemaTimelineRange;
  points: SchemaTimelinePoint[];
  schema_changes: SchemaTimelineChange[];
  index_changes: SchemaTimelineChange[];
  table_growth: SchemaTimelineTableGrowth[];
};

export type MigrationRiskScoreLevel = "low" | "medium" | "high" | "critical";

export type MigrationRiskScoreRequest = {
  project_id: string;
  connection_id: string;
  lookback_days?: number;
};

export type MigrationRiskScoreResponse = {
  project_id: string;
  connection_id: string;
  analyzed_at: string;
  lookback_days: number;
  risk_score: number;
  risk_level: MigrationRiskScoreLevel;
  factors: {
    table_size_rows: number;
    active_connections: number;
    indexes_affected: number;
    lock_duration_seconds: number;
  };
  recommendations: string[];
};

export type IndexHealthStatus = "unused_index" | "missing_index";

export type IndexHealthFinding = {
  index_name: string;
  status: IndexHealthStatus;
  recommendation: string;
};

export type IndexHealthAnalyzeRequest = {
  project_id: string;
  connection_id: string;
};

export type IndexHealthAnalyzeResponse = {
  project_id: string;
  connection_id: string;
  analyzed_at: string;
  inserted_count: number;
  findings: IndexHealthFinding[];
};

export type DatabaseHealthScoreBreakdown = {
  query_performance: number;
  schema_quality: number;
  index_efficiency: number;
  lock_contention: number;
};

export type DatabaseHealthSlowQuery = {
  query_id: string | null;
  query_text: string;
  calls: number;
  mean_exec_time_ms: number;
  total_exec_time_ms: number;
};

export type DatabaseHealthIndexFinding = {
  index_name: string;
  recommendation: string;
};

export type DatabaseHealthSchemaRisk = {
  change_type: string;
  object_name: string;
  detected_at: string;
  risk_level: "low" | "medium" | "high";
  recommendation: string;
};

export type DatabaseHealthReportGenerateRequest = {
  project_id: string;
  connection_id: string;
};

export type DatabaseHealthReportExportPdfRequest = {
  project_id: string;
  connection_id: string;
};

export type DatabaseHealthReportGenerateResponse = {
  project_id: string;
  connection_id: string;
  report_week_start: string;
  generated_at: string;
  inserted_count: number;
  health_score: number;
  score_breakdown: DatabaseHealthScoreBreakdown;
  top_slow_queries: DatabaseHealthSlowQuery[];
  missing_indexes: DatabaseHealthIndexFinding[];
  unused_indexes: DatabaseHealthIndexFinding[];
  schema_risks: DatabaseHealthSchemaRisk[];
  ai_summary: string;
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
  eventType: "query_analysis" | "query_execute" | "ai_explain" | "ai_suggest" | "reanalyze";
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
