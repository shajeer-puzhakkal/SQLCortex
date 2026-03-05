import type { CostBucket, CostNormalizationOptions, CostThresholds } from "../types";

export const DEFAULT_COST_THRESHOLDS: CostThresholds = {
  lowMax: 1_000,
  mediumMax: 10_000,
  highMax: 100_000,
};

function resolveThresholds(overrides?: Partial<CostThresholds>): CostThresholds {
  const lowMax = Math.max(0, overrides?.lowMax ?? DEFAULT_COST_THRESHOLDS.lowMax);
  const mediumMax = Math.max(lowMax, overrides?.mediumMax ?? DEFAULT_COST_THRESHOLDS.mediumMax);
  const highMax = Math.max(mediumMax, overrides?.highMax ?? DEFAULT_COST_THRESHOLDS.highMax);
  return {
    lowMax,
    mediumMax,
    highMax,
  };
}

export function normalizeCost(
  totalCost: number | null,
  options: CostNormalizationOptions = {},
): CostBucket {
  void options.tableStats;

  if (totalCost === null || !Number.isFinite(totalCost) || totalCost < 0) {
    return "Unknown";
  }

  const thresholds = resolveThresholds(options.thresholds);
  if (totalCost <= thresholds.lowMax) {
    return "Low";
  }
  if (totalCost <= thresholds.mediumMax) {
    return "Medium";
  }
  if (totalCost <= thresholds.highMax) {
    return "High";
  }
  return "Extreme";
}
