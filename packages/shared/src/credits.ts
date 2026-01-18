import { normalizeSql } from "./sql";

export type CreditAction =
  | "explain"
  | "index-suggest"
  | "optimize"
  | "rewrite"
  | "schema-analysis"
  | "analyze"
  | "risk-check";

export type ModelTier = "standard" | "premium" | "enterprise";

export type CreditEstimate = {
  base: number;
  complexity: number;
  total: number;
  lengthBucket: number;
  queryComplexity: number;
  modelTier: ModelTier;
  modelTierAdjustment: number;
};

const BASE_COSTS: Record<CreditAction, number> = {
  explain: 5,
  "index-suggest": 8,
  optimize: 10,
  rewrite: 10,
  "schema-analysis": 15,
  analyze: 15,
  "risk-check": 10,
};

const MODEL_TIER_ADJUSTMENTS: Record<ModelTier, number> = {
  standard: 0,
  premium: 2,
  enterprise: 4,
};

function countKeyword(haystack: string, keyword: string): number {
  if (!haystack) {
    return 0;
  }
  const regex = new RegExp(`\\b${keyword}\\b`, "g");
  const matches = haystack.match(regex);
  return matches ? matches.length : 0;
}

function resolveLengthBucket(length: number): number {
  if (length <= 500) {
    return 0;
  }
  if (length <= 2000) {
    return 2;
  }
  if (length <= 8000) {
    return 4;
  }
  return 6;
}

function resolveQueryComplexityScore(cleanedSql: string): number {
  const joinCount = countKeyword(cleanedSql, "join");
  const selectCount = countKeyword(cleanedSql, "select");
  const cteCount = countKeyword(cleanedSql, "with");
  const subqueryCount = Math.max(0, selectCount - 1);

  const joinScore = Math.min(4, joinCount);
  const subqueryScore = Math.min(4, subqueryCount * 2);
  const cteScore = Math.min(2, cteCount);

  return Math.min(6, joinScore + subqueryScore + cteScore);
}

export function estimateCredits(input: {
  action: CreditAction;
  sql: string;
  modelTier?: ModelTier;
}): CreditEstimate {
  const cleaned = normalizeSql(input.sql ?? "").toLowerCase();
  const base = BASE_COSTS[input.action] ?? 10;
  const lengthBucket = resolveLengthBucket(cleaned.length);
  const queryComplexity = resolveQueryComplexityScore(cleaned);
  const modelTier = input.modelTier ?? "standard";
  const modelTierAdjustment = MODEL_TIER_ADJUSTMENTS[modelTier] ?? 0;
  const complexity = Math.min(10, lengthBucket + queryComplexity + modelTierAdjustment);
  const total = Math.max(1, base + complexity);

  return {
    base,
    complexity,
    total,
    lengthBucket,
    queryComplexity,
    modelTier,
    modelTierAdjustment,
  };
}
