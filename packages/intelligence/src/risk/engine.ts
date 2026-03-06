import type { QueryFeatures, RiskAssessment, RiskReason } from "../types";
import {
  type RiskPolicy,
  defaultRiskPolicy,
  resolveRiskPolicy,
} from "./policy";
import {
  riskRules,
  TABLE_NAME_TOKEN,
  hasTargetInPolicyList,
  type RiskRuleKind,
} from "./rules";

const KNOWN_SQL_KEYWORDS = new Set([
  "from",
  "join",
  "update",
  "into",
  "using",
  "delete",
  "drop",
  "alter",
  "truncate",
  "table",
]);

function normalizeTableName(tableName: string): string {
  return tableName
    .replace(/["`[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

function mergeTables(values: string[]): string[] {
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeTableName(value);

    if (normalized && !KNOWN_SQL_KEYWORDS.has(normalized)) {
      seen.add(normalized);
    }
  }

  return [...seen];
}

function extractTablesFromSql(sqlText: string): string[] {
  const candidates = [...sqlText.matchAll(TABLE_NAME_TOKEN)];
  const extracted: string[] = [];
  let capture = false;

  for (const match of candidates) {
    const token = match[0]?.toLowerCase() ?? "";

    if (KNOWN_SQL_KEYWORDS.has(token)) {
      capture = true;
      continue;
    }

    if (!capture) {
      continue;
    }

    if (token === "if" || token === "exists" || token === "only") {
      continue;
    }

    if (token === ";") {
      capture = false;
      continue;
    }

    extracted.push(token);
    capture = false;
  }

  return mergeTables(extracted);
}

type RiskMatch = {
  kind: RiskRuleKind;
  reason: RiskReason;
};

export function evaluateRisk(
  queryFeatures: QueryFeatures,
  sqlText: string,
  policy: RiskPolicy = defaultRiskPolicy,
): RiskAssessment {
  const resolvedPolicy = resolveRiskPolicy(policy);
  const sql = sqlText.toLowerCase();
  const featureTables = queryFeatures.tables?.length ? queryFeatures.tables : [];
  const sqlTables = extractTablesFromSql(sql);
  const tables = mergeTables([...featureTables, ...sqlTables]);
  const context = {
    features: queryFeatures,
    tables,
    sqlText: sql,
    policy: resolvedPolicy,
  };

  const matches: RiskMatch[] = riskRules.flatMap((rule) => {
    if (!rule.match(context)) {
      return [];
    }

    return [
      {
        kind: rule.kind,
        reason: { code: rule.code, severity: rule.severity, message: rule.buildMessage(context) },
      },
    ];
  });

  const reasons = matches.map((entry) => ({
    code: entry.reason.code,
    severity: entry.reason.severity,
    message: entry.reason.message,
  }));
  const dangerous = matches.filter((entry) => entry.kind === "dangerous");
  const warningCount = matches.length - dangerous.length;
  const hasDangerousRules = dangerous.length > 0;
  const hasWarningRules = warningCount > 0;

  if (hasDangerousRules) {
    const firstReason = dangerous[0]?.reason.message ?? "Risk policy blocked execution.";
    return {
      risk_level: "Dangerous",
      reasons,
      gate: {
        can_execute: false,
        requires_confirmation: true,
        message: firstReason,
      },
    };
  }

  if (hasWarningRules) {
    const hasLogOrAudit = hasTargetInPolicyList(
      tables,
      resolvedPolicy.sensitiveSelectTables,
    );
    return {
      risk_level: "Warning",
      reasons,
      gate: {
        can_execute: true,
        requires_confirmation: false,
        message: hasLogOrAudit
          ? "Warnings include sensitive table reads; review before execution."
          : "Query is safe to run, but review flagged warnings.",
      },
    };
  }

  return {
    risk_level: "Safe",
    reasons: [],
    gate: {
      can_execute: true,
      requires_confirmation: false,
      message: "No dangerous risk patterns detected.",
    },
  };
}
