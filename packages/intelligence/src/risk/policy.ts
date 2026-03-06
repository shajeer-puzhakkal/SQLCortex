import riskPolicyJson from "./risk.policy.json";

const defaultRiskPolicy = riskPolicyJson as RiskPolicy;

const supportedEnvironments = ["dev", "qa", "prod"] as const;

export type RiskPolicyEnvironment = (typeof supportedEnvironments)[number];

export type RiskPolicyDdlRules = {
  allowTruncate: boolean;
  allowDropTable: boolean;
  allowAlterTable: boolean;
};

export type RiskPolicyWarningThresholds = {
  selectStarWithoutLimitTableCount: number;
  orderByWithoutLimitTableCount: number;
};

export type RiskPolicyEnvironmentConfig = {
  ddl: RiskPolicyDdlRules;
  ddlAllowlist: string[];
  warningThresholds: RiskPolicyWarningThresholds;
  sensitiveSelectTables: string[];
};

export type RiskPolicy = {
  environment: RiskPolicyEnvironment;
  environments: Record<RiskPolicyEnvironment, RiskPolicyEnvironmentConfig>;
};

export type ResolvedRiskPolicy = RiskPolicyEnvironmentConfig & {
  environment: RiskPolicyEnvironment;
};

function normalizeTableName(value: string): string {
  return value.toLowerCase().trim().replace(/["`[\]]/g, "");
}

function normalizeEnvironment(value: unknown): RiskPolicyEnvironment {
  return (typeof value === "string" && supportedEnvironments.includes(value as RiskPolicyEnvironment))
    ? (value as RiskPolicyEnvironment)
    : defaultRiskPolicy.environment;
}

function normalizeEnvironmentConfig(
  environmentConfig: RiskPolicyEnvironmentConfig,
): RiskPolicyEnvironmentConfig {
  return {
    ddl: {
      allowTruncate: environmentConfig.ddl.allowTruncate,
      allowDropTable: environmentConfig.ddl.allowDropTable,
      allowAlterTable: environmentConfig.ddl.allowAlterTable,
    },
    ddlAllowlist: Array.from(
      new Set(environmentConfig.ddlAllowlist.map((tableName) => normalizeTableName(tableName))),
    ),
    warningThresholds: {
      selectStarWithoutLimitTableCount: Math.max(
        1,
        environmentConfig.warningThresholds.selectStarWithoutLimitTableCount,
      ),
      orderByWithoutLimitTableCount: Math.max(
        1,
        environmentConfig.warningThresholds.orderByWithoutLimitTableCount,
      ),
    },
    sensitiveSelectTables: Array.from(
      new Set(environmentConfig.sensitiveSelectTables.map((tableName) => normalizeTableName(tableName))),
    ),
  };
}

export function resolveRiskPolicy(policy: RiskPolicy = defaultRiskPolicy): ResolvedRiskPolicy {
  const environment = normalizeEnvironment(policy.environment);
  const fallbackEnvironment = defaultRiskPolicy.environments[environment];
  const providedEnvironmentConfig = policy.environments[environment];
  const rawConfig =
    providedEnvironmentConfig.ddlAllowlist.length === 0 &&
    providedEnvironmentConfig.sensitiveSelectTables.length === 0
      ? fallbackEnvironment
      : providedEnvironmentConfig;
  const normalized = normalizeEnvironmentConfig({
    ddl: rawConfig.ddl,
    ddlAllowlist: rawConfig.ddlAllowlist,
    warningThresholds: rawConfig.warningThresholds,
    sensitiveSelectTables: rawConfig.sensitiveSelectTables,
  });
  return { ...normalized, environment };
}

export { defaultRiskPolicy };
