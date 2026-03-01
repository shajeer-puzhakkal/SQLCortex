import {
  type QueryFeatures,
  type ReasonSeverity,
  type Recommendation,
  type RuleMatch,
  type ScoreEngineConfig,
} from "../types";

export type ScoreRule = {
  code: string;
  description: string;
  severity: ReasonSeverity;
  defaultDelta: number;
  match: (features: QueryFeatures, config: ScoreEngineConfig) => boolean;
  buildMessage?: (features: QueryFeatures) => string;
  resolveDelta?: (
    features: QueryFeatures,
    config: ScoreEngineConfig,
    defaultDelta: number,
  ) => number;
  recommendation?: Recommendation | ((features: QueryFeatures) => Recommendation);
};

function recommendationFor(
  definition: ScoreRule["recommendation"],
  features: QueryFeatures,
): Recommendation | undefined {
  if (!definition) {
    return undefined;
  }

  return typeof definition === "function" ? definition(features) : definition;
}

export function createRuleMatch(
  rule: ScoreRule,
  features: QueryFeatures,
  config: ScoreEngineConfig,
  delta: number,
): RuleMatch {
  const reason = {
    code: rule.code,
    severity: rule.severity,
    delta,
    message: rule.buildMessage?.(features) ?? rule.description,
  };

  const recommendation = recommendationFor(rule.recommendation, features);

  if (!recommendation) {
    return { reason };
  }

  return {
    reason,
    recommendation,
  };
}

export const scoreRules: ScoreRule[] = [
  {
    code: "SELECT_STAR",
    description: "Avoid SELECT *; select only needed columns.",
    severity: "info",
    defaultDelta: -10,
    match: (features) => features.statement_type === "SELECT" && features.select_star,
    recommendation: {
      code: "SELECT_COLUMNS",
      message: "Project only the columns you need.",
      confidence: 0.9,
    },
  },
  {
    code: "MISSING_LIMIT",
    description: "Consider LIMIT when exploring large or joined result sets.",
    severity: "warn",
    defaultDelta: -15,
    match: (features, config) =>
      features.statement_type === "SELECT" &&
      !features.limit_present &&
      (features.select_star ||
        features.table_count >= config.thresholds.missingLimitTableCount ||
        features.join_count > 0 ||
        features.order_by_present),
    recommendation: {
      code: "ADD_LIMIT",
      message: "Add LIMIT while exploring to cap returned rows.",
      confidence: 0.55,
    },
  },
  {
    code: "TOO_MANY_JOINS",
    description: "Multiple joins add planning and execution overhead.",
    severity: "warn",
    defaultDelta: -20,
    match: (features, config) => features.join_count >= config.thresholds.moderateMinJoinCount,
    buildMessage: (features) =>
      `Query uses ${features.join_count} joins; verify each join is necessary and indexed.`,
    resolveDelta: (features, config, defaultDelta) =>
      features.join_count >= config.thresholds.complexMinJoinCount ? defaultDelta - 10 : defaultDelta,
    recommendation: {
      code: "REDUCE_JOINS",
      message: "Reduce join fan-out or validate indexes on join keys.",
      confidence: 0.65,
    },
  },
  {
    code: "DEEP_SUBQUERY",
    description: "Nested subqueries can hide expensive execution paths.",
    severity: "warn",
    defaultDelta: -15,
    match: (features, config) => features.subquery_depth >= config.thresholds.deepSubqueryDepth,
    buildMessage: (features) =>
      `Subquery depth is ${features.subquery_depth}; flatten nested queries when possible.`,
    recommendation: {
      code: "FLATTEN_SUBQUERIES",
      message: "Flatten nested subqueries or move repeated logic into a CTE.",
      confidence: 0.6,
    },
  },
  {
    code: "ORDER_BY_NO_INDEX_HINT",
    description: "ORDER BY may sort large result sets; verify supporting indexes.",
    severity: "warn",
    defaultDelta: -10,
    match: (features) => features.statement_type === "SELECT" && features.order_by_present,
    recommendation: {
      code: "REVIEW_SORT_INDEX",
      message: "Review indexes that match the ORDER BY columns.",
      confidence: 0.4,
    },
  },
  {
    code: "WINDOW_FUNCTION_COMPLEXITY",
    description: "Window functions increase planning complexity.",
    severity: "warn",
    defaultDelta: -8,
    match: (features) => features.has_window_functions,
    recommendation: {
      code: "REVIEW_WINDOW_USAGE",
      message: "Confirm the window partitioning is necessary and filtered early.",
      confidence: 0.5,
    },
  },
  {
    code: "WRITE_WITHOUT_WHERE",
    description: "Write statements without WHERE should be reviewed carefully.",
    severity: "high",
    defaultDelta: -40,
    match: (features) =>
      (features.statement_type === "UPDATE" || features.statement_type === "DELETE") &&
      !features.where_present,
    buildMessage: (features) => `${features.statement_type} without WHERE affects every matching row.`,
    recommendation: {
      code: "ADD_WRITE_FILTER",
      message: "Add a WHERE clause or confirm that touching every row is intentional.",
      confidence: 0.95,
    },
  },
  {
    code: "CARTESIAN_JOIN_RISK",
    description: "Join predicate looks incomplete and may create a cartesian product.",
    severity: "high",
    defaultDelta: -20,
    match: (features) => features.has_cartesian_join_risk,
    recommendation: {
      code: "ADD_JOIN_PREDICATE",
      message: "Add an explicit join predicate for each joined table.",
      confidence: 0.85,
    },
  },
  {
    code: "TARGETED_WHERE",
    description: "A targeted WHERE clause can reduce scanned rows.",
    severity: "info",
    defaultDelta: 5,
    match: (features) =>
      features.statement_type === "SELECT" &&
      features.where_present &&
      features.where_columns.length > 0,
  },
  {
    code: "SAFE_LIMIT",
    description: "LIMIT keeps exploratory queries bounded.",
    severity: "info",
    defaultDelta: 5,
    match: (features) => features.statement_type === "SELECT" && features.limit_present,
  },
];
