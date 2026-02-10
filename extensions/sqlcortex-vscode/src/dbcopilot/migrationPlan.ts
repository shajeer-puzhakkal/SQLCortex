import type { DbCopilotMode } from "../state/dbCopilotState";
import type {
  DbCopilotDbEngine,
  DbCopilotDdlOutput,
  DbCopilotGovernanceOutput,
  DbCopilotOptimizationPlan,
  DbCopilotPerformanceOutput,
  DbCopilotPolicyConfig,
  DbCopilotRiskOutput,
} from "./orchestrator";

export type DbCopilotMigrationPlanItem = {
  id: string;
  title: string;
  statement: string;
};

export type DbCopilotMigrationArtifacts = {
  migrationYaml: string;
  upSql: string;
  downSql: string;
  impactJson: string;
  complianceJson: string;
};

export type DbCopilotMigrationPlan = {
  id: string;
  title: string;
  mode: DbCopilotMode;
  environment: DbCopilotPolicyConfig["env"];
  engine: DbCopilotDbEngine;
  transactional: boolean;
  items: DbCopilotMigrationPlanItem[];
  impactSummary: Array<{ label: string; value: string }>;
  risk: DbCopilotRiskOutput | null;
  governance: DbCopilotGovernanceOutput | null;
  artifacts: DbCopilotMigrationArtifacts;
};

export type DbCopilotMigrationExecutionGate = {
  allowed: boolean;
  reasons: string[];
};

export function buildDbCopilotMigrationPlan(options: {
  plan: DbCopilotOptimizationPlan;
  mode: DbCopilotMode;
  engine: DbCopilotDbEngine;
  policies: DbCopilotPolicyConfig;
}): DbCopilotMigrationPlan | null {
  const { plan, mode, engine, policies } = options;
  const ddl = plan.outputs.ddl;
  if (!ddl) {
    return null;
  }
  const items = buildMigrationItems(ddl);
  const impactSummary = buildImpactSummary(plan.outputs.performance, plan.outputs.risk);
  const migrationYaml = ddl.migration_yaml || buildMigrationYamlFallback(ddl, engine);
  const artifacts: DbCopilotMigrationArtifacts = {
    migrationYaml,
    upSql: ddl.up_sql ?? "",
    downSql: ddl.down_sql ?? "",
    impactJson: JSON.stringify(plan.outputs.risk ?? {}, null, 2),
    complianceJson: JSON.stringify(plan.outputs.governance ?? {}, null, 2),
  };

  return {
    id: ddl.migration_id,
    title: ddl.title,
    mode,
    environment: policies.env,
    engine,
    transactional: ddl.transactional,
    items,
    impactSummary,
    risk: plan.outputs.risk ?? null,
    governance: plan.outputs.governance ?? null,
    artifacts,
  };
}

export function evaluateDbCopilotMigrationExecutionGate(
  plan: DbCopilotMigrationPlan,
  options?: { allowProd?: boolean }
): DbCopilotMigrationExecutionGate {
  const reasons: string[] = [];
  if (plan.mode !== "execution") {
    reasons.push("Execution mode is required.");
  }
  if (plan.environment === "prod" && !options?.allowProd) {
    reasons.push("Production execution is blocked (enterprise override required).");
  }
  if (!plan.governance) {
    reasons.push("Governance review is missing.");
  } else if (!plan.governance.compliant) {
    reasons.push("Governance violations must be resolved.");
  }
  if (!plan.risk) {
    reasons.push("Risk review is missing.");
  } else if (plan.risk.final_gate !== "approve") {
    reasons.push(`Risk gate is ${titleCase(plan.risk.final_gate)}.`);
  }
  if (!plan.items.length) {
    reasons.push("No statements are available to execute.");
  }
  return { allowed: reasons.length === 0, reasons };
}

export function buildDbCopilotMigrationSqlExport(plan: DbCopilotMigrationPlan): string {
  const parts: string[] = [
    `-- Migration: ${plan.id}`,
    `-- Title: ${plan.title}`,
    `-- Environment: ${formatEnvironment(plan.environment)}`,
    "",
    `-- Up${plan.transactional ? " (transactional)" : ""}`,
  ];
  if (plan.artifacts.upSql.trim()) {
    parts.push(plan.artifacts.upSql.trim());
  } else {
    parts.push("-- No up statements.");
  }
  parts.push("", "-- Down");
  if (plan.artifacts.downSql.trim()) {
    parts.push(plan.artifacts.downSql.trim());
  } else {
    parts.push("-- No down statements.");
  }
  return parts.join("\n");
}

export function buildDbCopilotMigrationTopRisks(
  plan: DbCopilotMigrationPlan
): string[] {
  const risks: string[] = [];
  if (plan.governance && !plan.governance.compliant) {
    const violations = plan.governance.violations.length
      ? plan.governance.violations.map((entry) => formatGovernanceViolation(entry)).join("; ")
      : "Policy violations detected.";
    risks.push(`Policy violations: ${violations}`);
  }
  if (plan.risk?.breaking_changes.length) {
    risks.push(`Breaking changes: ${plan.risk.breaking_changes.join(", ")}`);
  }
  if (plan.risk?.policy_violations.length && !plan.governance) {
    risks.push(`Policy violations: ${plan.risk.policy_violations.join(", ")}`);
  }
  if (plan.risk?.lock_contention_risk && plan.risk.lock_contention_risk !== "low") {
    risks.push(`Lock contention risk: ${titleCase(plan.risk.lock_contention_risk)}`);
  }
  if (plan.risk?.data_loss_risk && plan.risk.data_loss_risk !== "none") {
    risks.push(`Data loss risk: ${titleCase(plan.risk.data_loss_risk)}`);
  }
  if (plan.risk?.final_gate && plan.risk.final_gate !== "approve") {
    risks.push(`Risk gate: ${titleCase(plan.risk.final_gate)}`);
  }
  if (!risks.length && plan.risk) {
    risks.push(
      `Lock contention risk: ${titleCase(plan.risk.lock_contention_risk)}`
    );
  }
  if (!risks.length) {
    risks.push("No high-risk flags detected.");
  }
  return risks.slice(0, 3);
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    buffer = "";
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      buffer += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        buffer += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      buffer += char;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === "-" && next === "-") {
        buffer += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        buffer += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }
      const detectedTag = detectDollarTag(sql, index);
      if (detectedTag) {
        buffer += detectedTag;
        index += detectedTag.length - 1;
        dollarTag = detectedTag;
        continue;
      }
    }

    if (!inDouble && char === "'") {
      buffer += char;
      if (inSingle && next === "'") {
        buffer += next;
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      buffer += char;
      continue;
    }

    if (!inSingle && !inDouble && char === ";") {
      pushBuffer();
      continue;
    }

    buffer += char;
  }

  if (buffer.trim()) {
    pushBuffer();
  }

  return statements;
}

function detectDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== "$") {
    return null;
  }
  const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
  return match ? match[0] : null;
}

function buildMigrationItems(ddl: DbCopilotDdlOutput): DbCopilotMigrationPlanItem[] {
  const statements = splitSqlStatements(ddl.up_sql ?? "");
  if (!statements.length && ddl.up_sql) {
    statements.push(ddl.up_sql);
  }
  if (!statements.length) {
    return [
      {
        id: "s1",
        title: ddl.title || "Migration step",
        statement: ddl.up_sql ?? "",
      },
    ];
  }
  return statements.map((statement, index) => ({
    id: `s${index + 1}`,
    title: formatStatementTitle(statement),
    statement,
  }));
}

function buildImpactSummary(
  performance?: DbCopilotPerformanceOutput,
  risk?: DbCopilotRiskOutput
): Array<{ label: string; value: string }> {
  const indexCount = performance?.index_recommendations?.length ?? 0;
  const storage = indexCount ? "Increase (new indexes)" : "No change detected";
  const writeCost = indexCount ? "Increase (index maintenance)" : "Unknown";
  const riskSummary = risk
    ? `Lock: ${titleCase(risk.lock_contention_risk)}, Data loss: ${titleCase(risk.data_loss_risk)}`
    : "Unknown";
  return [
    { label: "Storage", value: storage },
    { label: "Write cost", value: writeCost },
    { label: "Risks", value: riskSummary },
  ];
}

function buildMigrationYamlFallback(ddl: DbCopilotDdlOutput, engine: DbCopilotDbEngine): string {
  const lines: string[] = [
    `id: ${yamlQuote(ddl.migration_id)}`,
    `title: ${yamlQuote(ddl.title)}`,
    `engine: ${yamlQuote(engine)}`,
    `transactional: ${ddl.transactional ? "true" : "false"}`,
  ];

  if (ddl.up_sql?.trim()) {
    lines.push("up: |", ...indentBlock(ddl.up_sql));
  } else {
    lines.push('up: ""');
  }

  if (ddl.down_sql?.trim()) {
    lines.push("down: |", ...indentBlock(ddl.down_sql));
  } else {
    lines.push('down: ""');
  }

  if (ddl.notes?.trim()) {
    lines.push(`notes: ${yamlQuote(ddl.notes)}`);
  }

  return lines.join("\n");
}

function indentBlock(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n").map((line) => `  ${line}`);
}

function formatStatementTitle(statement: string): string {
  const firstLine = statement.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Migration statement";
  }
  if (compact.length > 80) {
    return `${compact.slice(0, 77)}...`;
  }
  return compact;
}

function formatGovernanceViolation(
  violation: DbCopilotGovernanceOutput["violations"][number]
): string {
  const detail = [violation.object, violation.detail].filter(Boolean).join(": ");
  return detail ? `${violation.rule} (${detail})` : violation.rule;
}

function formatEnvironment(env: DbCopilotPolicyConfig["env"]): string {
  switch (env) {
    case "prod":
      return "Production";
    case "staging":
      return "Staging";
    default:
      return "Development";
  }
}

function titleCase(value: string): string {
  if (value === "med") {
    return "Medium";
  }
  return value
    .split(/[_\s]+/g)
    .map((chunk) => (chunk ? chunk[0].toUpperCase() + chunk.slice(1) : ""))
    .join(" ")
    .trim();
}

function yamlQuote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
