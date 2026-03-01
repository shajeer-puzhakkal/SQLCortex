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

export type ComplexityRating = "Simple" | "Moderate" | "Complex";

export type PerformanceLabel = "Excellent" | "Good" | "Needs Optimization" | "Risky";

export type CostBucket = "Unknown" | "Low" | "Medium" | "High";

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
};

export type RuleMatch = {
  reason: ScoreReason;
  recommendation?: Recommendation;
};
