import type { QueryFeatures } from "../types";
import type { ResolvedRiskPolicy } from "./policy";

const TABLE_NAME_TOKEN = /[^.\s,;()]+/gi;

export type RiskRuleKind = "dangerous" | "warning";

export type RiskRule = {
  code: string;
  kind: RiskRuleKind;
  severity: "warn" | "high";
  match: (params: {
    features: QueryFeatures;
    tables: string[];
    sqlText: string;
    policy: ResolvedRiskPolicy;
  }) => boolean;
  buildMessage: (params: {
    features: QueryFeatures;
    tables: string[];
    sqlText: string;
    policy: ResolvedRiskPolicy;
  }) => string;
};

function containsToken(sqlText: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b`, "i").test(sqlText);
}

function hasTargetInPolicyList(tables: string[], policyList: string[]): boolean {
  if (policyList.length === 0 || tables.length === 0) {
    return false;
  }

  const policySet = new Set(policyList.map((value) => value.toLowerCase()));

  for (const table of tables) {
    const normalized = table.toLowerCase().trim();
    const baseTable = normalized.includes(".") ? normalized.split(".").pop() ?? normalized : normalized;

    for (const policyTable of policySet) {
      if (baseTable === policyTable || normalized.includes(`.${policyTable}`) || normalized.includes(policyTable)) {
        return true;
      }
    }
  }

  return false;
}

function hasSensitiveTable(tables: string[], policyList: string[]): boolean {
  return hasTargetInPolicyList(tables, policyList);
}

function hasDdlRule(sqlText: string, token: "TRUNCATE TABLE" | "DROP TABLE" | "ALTER TABLE"): boolean {
  return new RegExp(`\\b${token.replace(" ", "\\s+")}\\b`, "i").test(sqlText);
}

function formatTableList(tables: string[]): string {
  if (tables.length === 0) {
    return "unknown table";
  }
  return tables.join(", ");
}

export const riskRules: RiskRule[] = [
  {
    code: "DELETE_WITHOUT_WHERE",
    kind: "dangerous",
    severity: "high",
    match: ({ features }) =>
      features.statement_type === "DELETE" &&
      !features.where_present,
    buildMessage: () => "DELETE without WHERE is dangerous and can affect all rows.",
  },
  {
    code: "UPDATE_WITHOUT_WHERE",
    kind: "dangerous",
    severity: "high",
    match: ({ features }) =>
      features.statement_type === "UPDATE" &&
      !features.where_present,
    buildMessage: () => "UPDATE without WHERE is dangerous and can affect all rows.",
  },
  {
    code: "TRUNCATE",
    kind: "dangerous",
    severity: "high",
    match: ({ tables, policy, sqlText }) =>
      hasDdlRule(sqlText, "TRUNCATE TABLE") &&
      !policy.ddl.allowTruncate &&
      !hasTargetInPolicyList(tables, policy.ddlAllowlist),
    buildMessage: ({ tables }) =>
      `TRUNCATE on ${formatTableList(tables)} is blocked by policy.`,
  },
  {
    code: "DROP_TABLE",
    kind: "dangerous",
    severity: "high",
    match: ({ tables, policy, sqlText }) =>
      hasDdlRule(sqlText, "DROP TABLE") &&
      !policy.ddl.allowDropTable &&
      !hasTargetInPolicyList(tables, policy.ddlAllowlist),
    buildMessage: ({ tables }) =>
      `DROP TABLE on ${formatTableList(tables)} is blocked by policy.`,
  },
  {
    code: "ALTER_TABLE",
    kind: "dangerous",
    severity: "high",
    match: ({ tables, policy, sqlText }) =>
      policy.environment === "prod" &&
      hasDdlRule(sqlText, "ALTER TABLE") &&
      !policy.ddl.allowAlterTable &&
      !hasTargetInPolicyList(tables, policy.ddlAllowlist),
    buildMessage: ({ tables }) =>
      `ALTER TABLE on ${formatTableList(tables)} is blocked on production policies.`,
  },
  {
    code: "SELECT_STAR_NO_LIMIT",
    kind: "warning",
    severity: "warn",
    match: ({ features, policy }) =>
      features.statement_type === "SELECT" &&
      features.select_star &&
      !features.limit_present &&
      features.table_count >= policy.warningThresholds.selectStarWithoutLimitTableCount,
    buildMessage: ({ features }) =>
      `SELECT * over ${features.table_count} table(s) has no LIMIT; consider adding one.`,
  },
  {
    code: "CARTESIAN_JOIN_RISK",
    kind: "warning",
    severity: "warn",
    match: ({ features }) => features.has_cartesian_join_risk,
    buildMessage: () => "Join predicates are missing; review for cartesian product risk.",
  },
  {
    code: "ORDER_BY_NO_LIMIT",
    kind: "warning",
    severity: "warn",
    match: ({ features, policy }) =>
      features.statement_type === "SELECT" &&
      features.order_by_present &&
      !features.limit_present &&
      features.table_count >= policy.warningThresholds.orderByWithoutLimitTableCount,
    buildMessage: ({ features }) =>
      `ORDER BY without LIMIT on ${features.table_count} table(s) may be expensive.`,
  },
  {
    code: "SENSITIVE_TABLE_NO_WHERE",
    kind: "warning",
    severity: "warn",
    match: ({ features, tables, policy }) =>
      features.statement_type === "SELECT" &&
      !features.where_present &&
      hasSensitiveTable(tables, policy.sensitiveSelectTables),
    buildMessage: ({ tables }) =>
      `SELECT from ${formatTableList(tables)} without WHERE should be reviewed.`,
  },
];

export { hasSensitiveTable, hasTargetInPolicyList, TABLE_NAME_TOKEN };
