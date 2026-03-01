import defaultConfigJson from "../../intelligence.config.json";
import { createRuleMatch, scoreRules } from "../rules/catalog";
import {
  type ComplexityRating,
  type IntelligenceModeConfig,
  type IntelligenceResult,
  type PartialScoreEngineConfig,
  type PerformanceLabel,
  type QueryFeatures,
  type ScoreEngineConfig,
  type ScoreEngineMode,
  type ScoreEngineOptions,
} from "../types";

const defaultConfig = defaultConfigJson as ScoreEngineConfig;

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function getPerformanceLabel(score: number): PerformanceLabel {
  if (score >= 90) {
    return "Excellent";
  }

  if (score >= 70) {
    return "Good";
  }

  if (score >= 50) {
    return "Needs Optimization";
  }

  return "Risky";
}

export function getComplexityRating(
  features: QueryFeatures,
  config: ScoreEngineConfig = defaultConfig,
): ComplexityRating {
  const { thresholds } = config;

  const isComplex =
    features.join_count >= thresholds.complexMinJoinCount ||
    features.subquery_depth >= thresholds.complexSubqueryDepth ||
    features.cte_count >= thresholds.complexCteCount ||
    features.has_window_functions;

  if (isComplex) {
    return "Complex";
  }

  const isModerate =
    (features.join_count >= thresholds.moderateMinJoinCount &&
      features.join_count <= thresholds.moderateMaxJoinCount) ||
    features.subquery_depth >= thresholds.moderateSubqueryDepth ||
    features.cte_count >= thresholds.moderateCteCount;

  if (isModerate) {
    return "Moderate";
  }

  return "Simple";
}

export function resolveScoreEngineConfig(
  overrides?: PartialScoreEngineConfig,
  mode: ScoreEngineMode = "fast",
): ScoreEngineConfig {
  void mode;

  const modes = Object.entries(defaultConfig.modes).reduce<Record<string, IntelligenceModeConfig>>(
    (accumulator, [modeName, modeConfig]) => {
      accumulator[modeName] = {
        ...modeConfig,
        ...(overrides?.modes?.[modeName] ?? {}),
      };
      return accumulator;
    },
    {},
  );

  return {
    rules: Object.entries(defaultConfig.rules).reduce<Record<string, ScoreEngineConfig["rules"][string]>>(
      (accumulator, [code, ruleConfig]) => {
        accumulator[code] = {
          ...ruleConfig,
          ...(overrides?.rules?.[code] ?? {}),
        };
        return accumulator;
      },
      {},
    ),
    modes,
    thresholds: {
      ...defaultConfig.thresholds,
      ...(overrides?.thresholds ?? {}),
    },
    explainAllowlist: overrides?.explainAllowlist ?? [...defaultConfig.explainAllowlist],
  };
}

export function evaluateQueryFeatures(
  features: QueryFeatures,
  options: ScoreEngineOptions = {},
): IntelligenceResult {
  const mode = options.mode ?? "fast";
  const config = resolveScoreEngineConfig(options.config, mode);
  const reasons: IntelligenceResult["reasons"] = [];
  const recommendations: IntelligenceResult["recommendations"] = [];
  let score = 100;

  for (const rule of scoreRules) {
    const ruleConfig = config.rules[rule.code];

    if (!ruleConfig?.enabled || !rule.match(features, config)) {
      continue;
    }

    const configuredDelta = ruleConfig.delta ?? rule.defaultDelta;
    const resolvedDelta = rule.resolveDelta?.(features, config, configuredDelta) ?? configuredDelta;
    const match = createRuleMatch(rule, features, config, resolvedDelta);

    score += match.reason.delta;
    reasons.push(match.reason);

    if (match.recommendation) {
      recommendations.push(match.recommendation);
    }
  }

  const performanceScore = clampScore(score);

  return {
    version: "v1",
    performance_score: performanceScore,
    performance_label: getPerformanceLabel(performanceScore),
    cost_bucket: "Unknown",
    risk_level: "Unknown",
    complexity_rating: getComplexityRating(features, config),
    reasons,
    recommendations,
  };
}
