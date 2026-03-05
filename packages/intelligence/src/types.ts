export type StatementType =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "DDL"
  | "UNKNOWN";

export type ReasonSeverity = "info" | "warn" | "high";

export type RiskLevel = "Unknown" | "Pending" | "Safe" | "Warning" | "Dangerous";

export type RiskReasonSeverity = "warn" | "high";

export type RiskReason = {
  code: string;
  severity: RiskReasonSeverity;
  message: string;
};

export type RiskGate = {
  can_execute: boolean;
  requires_confirmation: boolean;
  message: string;
};

export type RiskAssessment = {
  risk_level: RiskLevel;
  reasons: RiskReason[];
  gate: RiskGate;
};

export type ComplexityRating = "Simple" | "Moderate" | "Complex";

export type PerformanceLabel = "Excellent" | "Good" | "Needs Optimization" | "Risky";

export type CostBucket = "Unknown" | "Low" | "Medium" | "High" | "Extreme";

export type PlanNodeSummary = {
  node_type: string;
  count: number;
};

export type PlanSummary = {
  total_cost: number | null;
  plan_rows: number | null;
  plan_width: number | null;
  node_summary: PlanNodeSummary[];
  has_seq_scan: boolean;
  has_hash_join: boolean;
  has_sort: boolean;
  has_nested_loop: boolean;
};

export type QueryFeatures = {
  statement_type: StatementType;
  select_star: boolean;
  table_count: number;
  join_count: number;
  where_present: boolean;
  limit_present: boolean;
  order_by_present: boolean;
  group_by_present?: boolean;
  cte_count: number;
  subquery_depth: number;
  has_cartesian_join_risk: boolean;
  where_columns: string[];
  join_columns: string[];
  uses_functions: string[];
  has_aggregation: boolean;
  has_window_functions: boolean;
  tables?: string[];
  parse_confidence?: "high" | "low";
};

export type ScoreReason = {
  code: string;
  severity: ReasonSeverity;
  delta: number;
  message: string;
};

export type Recommendation = {
  code: string;
  message: string;
  confidence: number;
};

export type IntelligenceResult = {
  version: "v1";
  performance_score: number;
  performance_label: PerformanceLabel;
  cost_bucket: CostBucket;
  risk_level: RiskLevel;
  complexity_rating: ComplexityRating;
  reasons: ScoreReason[];
  recommendations: Recommendation[];
  risk_reasons?: RiskReason[];
  risk_gate?: RiskGate;
  plan_summary?: PlanSummary;
};

export type RuleWeightConfig = {
  enabled: boolean;
  delta?: number;
};

export type IntelligenceModeConfig = {
  allowExplain: boolean;
};

export type ScoreEngineThresholds = {
  simpleMaxJoinCount: number;
  moderateMinJoinCount: number;
  moderateMaxJoinCount: number;
  complexMinJoinCount: number;
  moderateSubqueryDepth: number;
  complexSubqueryDepth: number;
  moderateCteCount: number;
  complexCteCount: number;
  missingLimitTableCount: number;
  deepSubqueryDepth: number;
};

export type ScoreEngineConfig = {
  rules: Record<string, RuleWeightConfig>;
  modes: Record<string, IntelligenceModeConfig>;
  thresholds: ScoreEngineThresholds;
  explainAllowlist: string[];
};

export type PartialScoreEngineConfig = {
  rules?: Record<string, Partial<RuleWeightConfig>>;
  modes?: Record<string, Partial<IntelligenceModeConfig>>;
  thresholds?: Partial<ScoreEngineThresholds>;
  explainAllowlist?: string[];
};

export type ScoreEngineMode = "fast" | "plan";

export type ScoreEngineOptions = {
  mode?: ScoreEngineMode;
  config?: PartialScoreEngineConfig;
  queryText?: string;
  policy?: import("./risk/policy").RiskPolicy;
};

export type RuleMatch = {
  reason: ScoreReason;
  recommendation?: Recommendation;
};

export type CostThresholds = {
  lowMax: number;
  mediumMax: number;
  highMax: number;
};

export type CostNormalizationOptions = {
  thresholds?: Partial<CostThresholds>;
  // Reserved for future size-aware normalization.
  tableStats?: {
    estimatedRows?: number | null;
  };
};
