import type { DbCopilotSchemaSnapshot } from "./schemaSnapshot";
import { createHash } from "crypto";
import type {
  DbCopilotAuditLogEntry,
  DbCopilotLogEntry,
  DbCopilotLogSource,
  DbCopilotRiskImpactState,
  DbCopilotSqlPreviewState,
} from "./bottomPanelState";
import { buildMigrationDiff } from "../core/migration/MigrationDiffBuilder";
import {
  appendRollbackPlanToRiskSummary,
  generateRollbackPlan,
  type RollbackPlan,
} from "../core/migration/RollbackGenerator";
import type { SchemaSnapshot } from "../core/schema/SchemaTypes";

export type DbCopilotDbEngine =
  | "postgres"
  | "mysql"
  | "sqlserver"
  | "oracle"
  | "sqlite"
  | "unknown";

export type DbCopilotIntent =
  | "optimize_query"
  | "create_table"
  | "improve_relationships"
  | "review_procedure"
  | "other";

export type DbCopilotAgent =
  | "schema_analyst"
  | "performance"
  | "ddl"
  | "procedure"
  | "risk"
  | "governance"
  | "explainability"
  | "orchestrator";

export type DbCopilotPlanStep = {
  step_id: string;
  agent: DbCopilotAgent;
  objective: string;
  inputs: Record<string, unknown>;
};

export type DbCopilotOrchestratorPlan = {
  intent: DbCopilotIntent;
  missing_context: string[];
  plan: DbCopilotPlanStep[];
  execution_mode: boolean;
  notes: string | null;
};

export type DbCopilotPolicyConfig = {
  env: "dev" | "staging" | "prod";
  allow_drop: boolean;
  require_concurrent_index: boolean;
};

export type DbCopilotOrchestratorInput = {
  user_request: string;
  db_engine: DbCopilotDbEngine;
  connection_label: string | null;
  schema_snapshot: DbCopilotSchemaSnapshot | null;
  execution_mode: boolean;
  policies: DbCopilotPolicyConfig;
  query_text?: string | null;
  explain_plan?: string | null;
  now?: Date;
  log_session_id?: string;
};

export type DbCopilotSchemaAnalystOutput = {
  table_count: number;
  foreign_key_count: number;
  relationships: Array<{ from: string; to: string; type: "1:N" | "N:M" | "1:1" }>;
  missing_constraints: Array<{ table: string; column: string; reason: string }>;
  notes: string | null;
};

export type DbCopilotPerformanceOutput = {
  bottlenecks: string[];
  index_recommendations: Array<{
    table: string;
    columns: string[];
    index_type: string;
    partial_predicate: string | null;
    estimated_benefit: string;
  }>;
  query_rewrites: Array<{ before: string; after: string; reason: string }>;
  sql_preview: {
    create_indexes: string[];
    drop_or_replace: string[];
  };
  risk_summary: string;
};

export type DbCopilotDdlOutput = {
  migration_id: string;
  title: string;
  transactional: boolean;
  up_sql: string;
  down_sql: string;
  migration_yaml: string;
  notes: string;
};

export type DbCopilotRiskOutput = {
  breaking_changes: string[];
  lock_contention_risk: "low" | "med" | "high";
  migration_window_friendly: boolean;
  data_loss_risk: "none" | "potential" | "probable";
  mitigations: string[];
  policy_violations: string[];
  requires_manual_review: boolean;
  final_gate: "approve" | "reject" | "revise";
  rollback_plan?: RollbackPlan;
};

export type DbCopilotGovernanceOutput = {
  compliant: boolean;
  violations: Array<{ rule: string; object: string; detail: string }>;
  recommendations: string[];
};

export type DbCopilotExplainabilityOutput = {
  markdown: string;
};

export type DbCopilotAgentOutputs = {
  schema_analyst?: DbCopilotSchemaAnalystOutput;
  performance?: DbCopilotPerformanceOutput;
  ddl?: DbCopilotDdlOutput;
  procedure?: { notes: string };
  risk?: DbCopilotRiskOutput;
  governance?: DbCopilotGovernanceOutput;
  explainability?: DbCopilotExplainabilityOutput;
};

export type DbCopilotOptimizationPlan = {
  orchestrator: DbCopilotOrchestratorPlan;
  outputs: DbCopilotAgentOutputs;
  merged: {
    sql_preview: DbCopilotSqlPreviewState | null;
    risk_impact: DbCopilotRiskImpactState | null;
    explanation_markdown: string | null;
  };
  logs: DbCopilotLogEntry[];
  auditLogs: DbCopilotAuditLogEntry[];
  logSessionId: string;
};

export const DB_COPILOT_AGENT_MATRIX: Array<{
  agent: DbCopilotAgent;
  input: string;
  output: string;
}> = [
  { agent: "schema_analyst", input: "Tables, FKs", output: "Relationship insights" },
  { agent: "performance", input: "EXPLAIN plans", output: "Index/query suggestions" },
  { agent: "ddl", input: "Requirements", output: "CREATE/ALTER scripts" },
  { agent: "procedure", input: "Proc definitions", output: "Refactored SQL" },
  { agent: "risk", input: "All changes", output: "Breaking-change alerts" },
  { agent: "governance", input: "Policies", output: "Allowed/blocked actions" },
  { agent: "explainability", input: "Proposals + risks", output: "User-facing Markdown" },
  { agent: "orchestrator", input: "User request + context", output: "Plan + merged result" },
];

type DbCopilotPlanTemplate = {
  step_id: string;
  agent: DbCopilotAgent;
  objective: string;
  inputs: (input: DbCopilotOrchestratorInput) => Record<string, unknown>;
};

const PLAN_TEMPLATES: Record<DbCopilotIntent, DbCopilotPlanTemplate[]> = {
  optimize_query: [
    {
      step_id: "s1",
      agent: "schema_analyst",
      objective: "Identify relevant entities + relationships + missing constraints",
      inputs: (input) => ({
        schema_snapshot: present(input.schema_snapshot),
        goals: "optimize_query",
      }),
    },
    {
      step_id: "s2",
      agent: "performance",
      objective: "Analyze EXPLAIN + propose indexes/rewrites",
      inputs: (input) => ({
        query_text: present(input.query_text),
        explain_plan: present(input.explain_plan),
        db_engine: input.db_engine,
      }),
    },
    {
      step_id: "s3",
      agent: "governance",
      objective: "Evaluate policy compliance for proposed changes",
      inputs: (input) => ({
        policies: input.policies,
      }),
    },
    {
      step_id: "s4",
      agent: "ddl",
      objective: "Generate migration YAML for accepted changes",
      inputs: (input) => ({
        db_engine: input.db_engine,
        policies: input.policies,
      }),
    },
    {
      step_id: "s5",
      agent: "risk",
      objective: "Compute risk/impact gate",
      inputs: (input) => ({
        env: input.policies.env,
      }),
    },
    {
      step_id: "s6",
      agent: "explainability",
      objective: "Generate Markdown explanation",
      inputs: (input) => ({
        audience: "app developer",
        db_engine: input.db_engine,
      }),
    },
    {
      step_id: "s7",
      agent: "orchestrator",
      objective: "Merge + publish Optimization Plan",
      inputs: () => ({
        merge_target: "optimization_plan",
      }),
    },
  ],
  create_table: [
    {
      step_id: "s1",
      agent: "schema_analyst",
      objective: "Determine naming/relationship fit",
      inputs: (input) => ({
        schema_snapshot: present(input.schema_snapshot),
        goals: "create_table",
      }),
    },
    {
      step_id: "s2",
      agent: "ddl",
      objective: "Produce create-table migration YAML",
      inputs: (input) => ({
        db_engine: input.db_engine,
        policies: input.policies,
      }),
    },
    {
      step_id: "s3",
      agent: "governance",
      objective: "Enforce conventions/policies",
      inputs: (input) => ({
        policies: input.policies,
      }),
    },
    {
      step_id: "s4",
      agent: "risk",
      objective: "Validate lock/impact",
      inputs: (input) => ({
        env: input.policies.env,
      }),
    },
    {
      step_id: "s5",
      agent: "explainability",
      objective: "Rationale + rollback notes",
      inputs: (input) => ({
        audience: "DBA",
        db_engine: input.db_engine,
      }),
    },
    {
      step_id: "s6",
      agent: "orchestrator",
      objective: "Merge + publish Migration Plan",
      inputs: () => ({
        merge_target: "migration_plan",
      }),
    },
  ],
  improve_relationships: [
    {
      step_id: "s1",
      agent: "schema_analyst",
      objective: "Identify missing constraints and relationship gaps",
      inputs: (input) => ({
        schema_snapshot: present(input.schema_snapshot),
        goals: "improve_relationships",
      }),
    },
    {
      step_id: "s2",
      agent: "ddl",
      objective: "Generate migration for approved constraints",
      inputs: (input) => ({
        db_engine: input.db_engine,
        policies: input.policies,
      }),
    },
    {
      step_id: "s3",
      agent: "governance",
      objective: "Enforce constraints policy",
      inputs: (input) => ({
        policies: input.policies,
      }),
    },
    {
      step_id: "s4",
      agent: "risk",
      objective: "Assess impact of relationship changes",
      inputs: (input) => ({
        env: input.policies.env,
      }),
    },
    {
      step_id: "s5",
      agent: "explainability",
      objective: "Explain constraints and rollbacks",
      inputs: (input) => ({
        audience: "data engineer",
        db_engine: input.db_engine,
      }),
    },
    {
      step_id: "s6",
      agent: "orchestrator",
      objective: "Merge + publish plan",
      inputs: () => ({
        merge_target: "relationship_plan",
      }),
    },
  ],
  review_procedure: [
    {
      step_id: "s1",
      agent: "procedure",
      objective: "Review stored procedure/function",
      inputs: (input) => ({
        db_engine: input.db_engine,
        request: input.user_request,
      }),
    },
    {
      step_id: "s2",
      agent: "risk",
      objective: "Assess procedural changes",
      inputs: (input) => ({
        env: input.policies.env,
      }),
    },
    {
      step_id: "s3",
      agent: "explainability",
      objective: "Explain recommended changes",
      inputs: (input) => ({
        audience: "DBA",
        db_engine: input.db_engine,
      }),
    },
    {
      step_id: "s4",
      agent: "orchestrator",
      objective: "Merge + publish plan",
      inputs: () => ({
        merge_target: "procedure_plan",
      }),
    },
  ],
  other: [
    {
      step_id: "s1",
      agent: "orchestrator",
      objective: "Clarify request and required context",
      inputs: () => ({
        request: "insufficient intent",
      }),
    },
  ],
};

export function detectDbCopilotIntent(userRequest: string): DbCopilotIntent {
  const normalized = userRequest.trim().toLowerCase();
  if (!normalized) {
    return "other";
  }
  const patterns: Array<{ intent: DbCopilotIntent; terms: string[] }> = [
    {
      intent: "create_table",
      terms: ["create table", "new table", "add table", "table schema"],
    },
    {
      intent: "review_procedure",
      terms: ["procedure", "stored procedure", "function", "plpgsql", "tsql"],
    },
    {
      intent: "improve_relationships",
      terms: ["relationship", "foreign key", "fk", "constraint", "join table"],
    },
    {
      intent: "optimize_query",
      terms: ["optimize", "performance", "slow", "index", "tune", "explain"],
    },
  ];
  for (const pattern of patterns) {
    if (pattern.terms.some((term) => normalized.includes(term))) {
      return pattern.intent;
    }
  }
  return "other";
}

export function buildDbCopilotOptimizationPlan(
  input: DbCopilotOrchestratorInput
): DbCopilotOptimizationPlan {
  const intent = detectDbCopilotIntent(input.user_request);
  const missing = resolveMissingContext(intent, input);
  const timestampBase = input.now ?? new Date();
  const logSessionId = input.log_session_id ?? createLogSessionId(timestampBase);
  const plan = buildPlan(intent, input);
  const orchestrator: DbCopilotOrchestratorPlan = {
    intent,
    missing_context: missing,
    plan,
    execution_mode: input.execution_mode,
    notes: missing.length ? "Awaiting required context." : null,
  };

  if (missing.length) {
    const auditLogs = buildMissingContextAuditLogs(
      intent,
      input,
      missing,
      logSessionId
    );
    return {
      orchestrator,
      outputs: {},
      merged: {
        sql_preview: null,
        risk_impact: null,
        explanation_markdown: null,
      },
      logs: buildMissingContextLogs(intent, input, missing),
      auditLogs,
      logSessionId,
    };
  }

  const outputs: DbCopilotAgentOutputs = {};
  const logs: DbCopilotLogEntry[] = [];
  const auditLogs: DbCopilotAuditLogEntry[] = [];
  logs.push(
    buildLogEntry(
      timestampBase,
      logs.length,
      "orchestrator",
      `Detected intent ${intent}.`
    )
  );
  auditLogs.push(
    buildAuditLogEntry({
      timestamp: new Date(),
      sessionId: logSessionId,
      agent: "orchestrator",
      message: `Detected intent ${intent}.`,
      input: {
        user_request: input.user_request,
        db_engine: input.db_engine,
        connection_label: input.connection_label,
        execution_mode: input.execution_mode,
        policies: input.policies,
        query_text: input.query_text ?? null,
        explain_plan: input.explain_plan ?? null,
      },
      output: { intent },
      durationMs: 0,
    })
  );

  for (const step of plan) {
    switch (step.agent) {
      case "schema_analyst": {
        const startedAt = Date.now();
        const result = runSchemaAnalyst(input.schema_snapshot);
        outputs.schema_analyst = result;
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "schema_analyst",
            `Schema snapshot: ${result.table_count} tables, ${result.foreign_key_count} FKs.`
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "schema_analyst",
            message: "Schema analysis completed.",
            input: { schema_snapshot: input.schema_snapshot },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "performance": {
        const startedAt = Date.now();
        const result = runPerformance(input);
        outputs.performance = result;
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "performance",
            `Identified ${result.index_recommendations.length} index candidate(s).`
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "performance",
            message: "Performance analysis completed.",
            input: {
              query_text: input.query_text ?? null,
              explain_plan: input.explain_plan ?? null,
              db_engine: input.db_engine,
            },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "governance": {
        const startedAt = Date.now();
        const result = runGovernance(input, outputs);
        outputs.governance = result;
        const durationMs = Date.now() - startedAt;
        const status = result.compliant ? "Compliant" : "Violations detected";
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "governance",
            `Policy check: ${status}.`
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "governance",
            message: "Governance evaluation completed.",
            input: {
              policies: input.policies,
              proposals: {
                indexes: outputs.performance?.sql_preview?.create_indexes ?? [],
                migration_id: outputs.ddl?.migration_id ?? null,
              },
            },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "ddl": {
        const startedAt = Date.now();
        const result = runDdl(intent, input, outputs);
        outputs.ddl = result;
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "ddl",
            `Generated migration ${result.migration_id}.`
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "ddl",
            message: "DDL migration generated.",
            input: {
              intent,
              db_engine: input.db_engine,
              policies: input.policies,
              performance: outputs.performance?.sql_preview ?? null,
            },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "risk": {
        const startedAt = Date.now();
        const result = runRisk(input, outputs);
        outputs.risk = result;
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "risk",
            `Risk gate: ${result.final_gate}.`
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "risk",
            message: "Risk assessment completed.",
            input: {
              env: input.policies.env,
              ddl_preview: outputs.ddl?.up_sql ?? null,
              governance: outputs.governance ?? null,
            },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "procedure": {
        const startedAt = Date.now();
        outputs.procedure = { notes: "Procedure analysis placeholder." };
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "procedure",
            "Reviewed stored procedure/function."
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "procedure",
            message: "Procedure review completed.",
            input: {
              db_engine: input.db_engine,
              request: input.user_request,
            },
            output: outputs.procedure,
            durationMs,
          })
        );
        break;
      }
      case "explainability": {
        const startedAt = Date.now();
        const result = runExplainability(input, outputs);
        outputs.explainability = result;
        const durationMs = Date.now() - startedAt;
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "explainability",
            "Generated developer-facing summary."
          )
        );
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "explainability",
            message: "Explainability summary generated.",
            input: {
              audience: "app developer",
              db_engine: input.db_engine,
              risk: outputs.risk ?? null,
              governance: outputs.governance ?? null,
            },
            output: result,
            durationMs,
          })
        );
        break;
      }
      case "orchestrator": {
        const startedAt = Date.now();
        logs.push(
          buildLogEntry(
            timestampBase,
            logs.length,
            "orchestrator",
            "Merged agent outputs into Optimization Plan."
          )
        );
        const durationMs = Date.now() - startedAt;
        auditLogs.push(
          buildAuditLogEntry({
            timestamp: new Date(),
            sessionId: logSessionId,
            agent: "orchestrator",
            message: "Merged agent outputs.",
            input: {
              intent,
              outputs_present: Object.keys(outputs),
            },
            output: {
              sql_preview: Boolean(outputs.ddl),
              risk_impact: Boolean(outputs.risk),
              explanation: Boolean(outputs.explainability),
            },
            durationMs,
          })
        );
        break;
      }
    }
  }

  const merged = mergeOutputs(input, outputs);
  return {
    orchestrator,
    outputs,
    merged,
    logs,
    auditLogs,
    logSessionId,
  };
}

export function resolveDbCopilotDbEngine(connectionLabel: string | null): DbCopilotDbEngine {
  const normalized = (connectionLabel ?? "").toLowerCase();
  if (normalized.includes("postgres")) {
    return "postgres";
  }
  if (normalized.includes("mysql")) {
    return "mysql";
  }
  if (normalized.includes("sqlserver") || normalized.includes("mssql")) {
    return "sqlserver";
  }
  if (normalized.includes("oracle")) {
    return "oracle";
  }
  if (normalized.includes("sqlite")) {
    return "sqlite";
  }
  return "unknown";
}

export function resolveDbCopilotPolicies(
  connectionLabel: string | null,
  dbEngine: DbCopilotDbEngine
): DbCopilotPolicyConfig {
  const normalized = (connectionLabel ?? "").toLowerCase();
  const env = normalized.includes("prod")
    ? "prod"
    : normalized.includes("staging")
      ? "staging"
      : "dev";
  return {
    env,
    allow_drop: env !== "prod",
    require_concurrent_index: dbEngine === "postgres",
  };
}

function resolveMissingContext(
  intent: DbCopilotIntent,
  input: DbCopilotOrchestratorInput
): string[] {
  const missing: string[] = [];
  if (intent === "optimize_query") {
    if (!input.schema_snapshot) {
      missing.push("schema_snapshot");
    }
    if (!input.query_text || !input.query_text.trim()) {
      missing.push("query_text");
    }
  }
  if (intent === "create_table") {
    if (!input.schema_snapshot) {
      missing.push("schema_snapshot");
    }
    if (!input.user_request.trim()) {
      missing.push("table_requirements");
    }
  }
  if (intent === "review_procedure" && !input.user_request.trim()) {
    missing.push("procedure_definition");
  }
  if (!input.user_request.trim()) {
    missing.push("user_request");
  }
  return Array.from(new Set(missing));
}

function buildPlan(intent: DbCopilotIntent, input: DbCopilotOrchestratorInput): DbCopilotPlanStep[] {
  const template = PLAN_TEMPLATES[intent] ?? PLAN_TEMPLATES.other;
  return template.map((step) => ({
    step_id: step.step_id,
    agent: step.agent,
    objective: step.objective,
    inputs: step.inputs(input),
  }));
}

function present(value: unknown): "present" | "missing" {
  if (value === null || typeof value === "undefined") {
    return "missing";
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return "missing";
  }
  if (Array.isArray(value) && value.length === 0) {
    return "missing";
  }
  return "present";
}

function runSchemaAnalyst(snapshot: DbCopilotSchemaSnapshot | null): DbCopilotSchemaAnalystOutput {
  if (!snapshot) {
    return {
      table_count: 0,
      foreign_key_count: 0,
      relationships: [],
      missing_constraints: [],
      notes: "No schema snapshot provided.",
    };
  }
  const relationships: Array<{ from: string; to: string; type: "1:N" | "N:M" | "1:1" }> = [];
  const missing_constraints: Array<{ table: string; column: string; reason: string }> = [];
  const fkColumns = new Set<string>();
  let foreignKeyCount = 0;

  for (const table of snapshot.tables) {
    for (const fk of table.foreignKeys) {
      foreignKeyCount += 1;
      relationships.push({
        from: table.name,
        to: fk.references.table,
        type: "1:N",
      });
      for (const column of fk.columns) {
        fkColumns.add(`${table.name}.${column}`);
      }
    }
  }

  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      if (column.name.endsWith("_id") && !fkColumns.has(`${table.name}.${column.name}`)) {
        missing_constraints.push({
          table: table.name,
          column: column.name,
          reason: "Column ends with _id but has no FK constraint.",
        });
      }
    }
  }

  return {
    table_count: snapshot.tables.length,
    foreign_key_count: foreignKeyCount,
    relationships,
    missing_constraints,
    notes: missing_constraints.length
      ? "Found FK-like columns without explicit constraints."
      : null,
  };
}

function runPerformance(input: DbCopilotOrchestratorInput): DbCopilotPerformanceOutput {
  const normalized = (input.query_text ?? "").toLowerCase();
  const recommendations: DbCopilotPerformanceOutput["index_recommendations"] = [];
  const createIndexes: string[] = [];
  let riskSummary = "No high-risk performance regressions detected.";

  if (normalized.includes("orders") || normalized.includes("order")) {
    const columns = normalized.includes("created_at") ? ["status", "created_at"] : ["status"];
    const partial =
      normalized.includes("status") && normalized.includes("pending")
        ? "status IN ('pending','paid')"
        : null;
    recommendations.push({
      table: "orders",
      columns,
      index_type: "btree",
      partial_predicate: partial,
      estimated_benefit: "Reduce sort + filter cost on orders.",
    });

    const predicate = partial ? ` WHERE ${partial}` : "";
    createIndexes.push(
      `CREATE INDEX idx_orders_status_created_at${partial ? "_partial" : ""} ON public.orders (${columns.join(
        ", "
      )})${predicate};`
    );
    riskSummary = "Index adds minor write overhead on orders.";
  }

  if (!recommendations.length) {
    recommendations.push({
      table: "unknown",
      columns: ["(add filters)"],
      index_type: "btree",
      partial_predicate: null,
      estimated_benefit: "Add selective predicates to enable index usage.",
    });
    createIndexes.push("-- Add index based on observed predicates.");
  }

  return {
    bottlenecks: normalized ? ["Potential filter + sort on primary table"] : ["No query text provided."],
    index_recommendations: recommendations,
    query_rewrites: [],
    sql_preview: {
      create_indexes: createIndexes,
      drop_or_replace: [],
    },
    risk_summary: riskSummary,
  };
}

function runGovernance(
  input: DbCopilotOrchestratorInput,
  outputs: DbCopilotAgentOutputs
): DbCopilotGovernanceOutput {
  const violations: DbCopilotGovernanceOutput["violations"] = [];
  const recommendations: string[] = [];
  const proposed = outputs.performance?.sql_preview?.create_indexes ?? [];
  const ddlSql = outputs.ddl?.up_sql ?? "";

  if (!input.policies.allow_drop && proposed.some((entry) => entry.toLowerCase().includes("drop "))) {
    violations.push({
      rule: "allow_drop=false",
      object: "schema change",
      detail: "DROP detected in proposed changes",
    });
  }
  if (!input.policies.allow_drop && ddlSql.toLowerCase().includes("drop ")) {
    violations.push({
      rule: "allow_drop=false",
      object: "migration",
      detail: "DROP detected in DDL output",
    });
  }

  if (input.policies.require_concurrent_index && input.db_engine === "postgres") {
    if (proposed.some((entry) => entry.toLowerCase().includes("create index"))) {
      recommendations.push("Use CREATE INDEX CONCURRENTLY on Postgres.");
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
    recommendations,
  };
}

function runDdl(
  intent: DbCopilotIntent,
  input: DbCopilotOrchestratorInput,
  outputs: DbCopilotAgentOutputs
): DbCopilotDdlOutput {
  if (intent === "create_table") {
    const tableName = extractTableName(input.user_request) ?? "new_table";
    const upSql = [
      `CREATE TABLE public.${tableName} (`,
      "  id uuid PRIMARY KEY,",
      "  created_at timestamptz NOT NULL DEFAULT now()",
      ");",
    ].join("\n");
    const downSql = input.policies.allow_drop
      ? `DROP TABLE IF EXISTS public.${tableName};`
      : "-- Rollback requires manual drop (allow_drop=false).";
    const migrationYaml = buildMigrationYaml({
      migrationId: `mig_create_${tableName}`,
      title: `Create ${tableName}`,
      transactional: true,
      engine: input.db_engine,
      upSql,
      downSql,
      notes: "Create table with primary key and timestamp.",
    });
    return {
      migration_id: `mig_create_${tableName}`,
      title: `Create ${tableName}`,
      transactional: true,
      up_sql: upSql,
      down_sql: downSql,
      migration_yaml: migrationYaml,
      notes: "Create table with primary key and timestamp.",
    };
  }
  const perf = outputs.performance;
  const baseIndex =
    perf?.index_recommendations?.[0] ?? {
      table: "orders",
      columns: ["status", "created_at"],
      partial_predicate: "status IN ('pending','paid')",
      index_type: "btree",
      estimated_benefit: "Reduce filter cost.",
    };
  const useConcurrently = input.db_engine === "postgres" && input.policies.require_concurrent_index;
  const concurrently = useConcurrently ? "CONCURRENTLY " : "";
  const indexName = `idx_${baseIndex.table}_${baseIndex.columns.join("_")}${baseIndex.partial_predicate ? "_partial" : ""}`;
  const predicate = baseIndex.partial_predicate ? ` WHERE ${baseIndex.partial_predicate}` : "";
  const upSql = [
    `CREATE INDEX ${concurrently}${indexName}`,
    `  ON public.${baseIndex.table} (${baseIndex.columns.join(", ")})${predicate};`,
  ].join("\n");
  const downSql = input.policies.allow_drop
    ? `DROP INDEX IF EXISTS ${indexName};`
    : "-- Rollback requires manual drop (allow_drop=false).";
  const title = `Optimize ${baseIndex.table} filters`;

  const migrationYaml = buildMigrationYaml({
    migrationId: `mig_${baseIndex.table}_${baseIndex.columns.join("_")}`,
    title,
    transactional: !useConcurrently,
    engine: input.db_engine,
    upSql,
    downSql,
    notes: useConcurrently
      ? "Uses CONCURRENTLY to reduce lock contention."
      : "Standard index creation.",
  });

  return {
    migration_id: `mig_${baseIndex.table}_${baseIndex.columns.join("_")}`,
    title,
    transactional: !useConcurrently,
    up_sql: upSql,
    down_sql: downSql,
    migration_yaml: migrationYaml,
    notes: useConcurrently
      ? "Uses CONCURRENTLY to reduce lock contention."
      : "Standard index creation.",
  };
}

function runRisk(input: DbCopilotOrchestratorInput, outputs: DbCopilotAgentOutputs): DbCopilotRiskOutput {
  const ddl = outputs.ddl;
  const governance = outputs.governance;
  const ddlText = ddl?.up_sql.toLowerCase() ?? "";
  const rollbackPlan = buildRollbackPlanForRisk(input, ddl?.up_sql ?? "");
  const breakingChanges = ddlText.includes("drop ") ? ["Drop detected"] : [];
  const lockRisk: DbCopilotRiskOutput["lock_contention_risk"] =
    ddlText.length === 0
      ? "med"
      : ddlText.includes("drop ") || ddlText.includes("alter table")
        ? "high"
        : ddlText.includes("concurrently")
          ? "low"
          : "med";
  const policyViolations = governance?.violations.map((entry) => entry.rule) ?? [];
  const dataLossRisk = classifyRollbackDataLossRisk(rollbackPlan);
  const requiresManualReview =
    policyViolations.length > 0 || breakingChanges.length > 0 || lockRisk === "high";
  const finalGate = requiresManualReview ? "revise" : "approve";
  const mitigations = lockRisk === "low" ? ["CONCURRENTLY used"] : ["Schedule off-peak"];
  if (rollbackPlan?.warnings.length) {
    mitigations.push("Review rollback warnings and capture backup before execution.");
  }

  return {
    breaking_changes: breakingChanges,
    lock_contention_risk: lockRisk,
    migration_window_friendly: lockRisk === "low",
    data_loss_risk: dataLossRisk,
    mitigations,
    policy_violations: policyViolations,
    requires_manual_review: requiresManualReview,
    final_gate: finalGate,
    rollback_plan: rollbackPlan ?? undefined,
  };
}

function buildRollbackPlanForRisk(
  input: DbCopilotOrchestratorInput,
  ddlSql: string
): RollbackPlan | null {
  if (!ddlSql.trim() || !input.schema_snapshot) {
    return null;
  }

  try {
    const snapshotBefore = toCoreSchemaSnapshot(input.schema_snapshot);
    const diffResult = buildMigrationDiff({
      snapshotBefore,
      ddlSql,
      defaultSchema: input.schema_snapshot.schema,
    });
    return generateRollbackPlan({
      migrationDiff: diffResult.migrationDiff,
    });
  } catch {
    // Keep risk evaluation resilient if simulation fails on unsupported SQL.
    return null;
  }
}

function classifyRollbackDataLossRisk(
  rollbackPlan: RollbackPlan | null
): DbCopilotRiskOutput["data_loss_risk"] {
  if (!rollbackPlan || rollbackPlan.warnings.length === 0) {
    return "none";
  }
  if (
    rollbackPlan.warnings.some((warning) =>
      /cannot\s+automatically\s+restore|cannot\s+be\s+recovered/i.test(warning)
    )
  ) {
    return "probable";
  }
  return "potential";
}

function toCoreSchemaSnapshot(snapshot: DbCopilotSchemaSnapshot): SchemaSnapshot {
  const schemaName = snapshot.schema || "public";
  const routines = (snapshot.routines ?? []).map((routine) => toCoreRoutine(routine));
  const functions = (snapshot.functions ?? []).map((routine) => toCoreRoutine(routine));
  const procedures = (snapshot.procedures ?? []).map((routine) => toCoreRoutine(routine));

  return {
    capturedAt: snapshot.capturedAt ?? undefined,
    schemas: [
      {
        name: schemaName,
        tables: snapshot.tables.map((table) => toCoreTableSnapshot(schemaName, table)),
        views: (snapshot.views ?? []).map((view) => ({
          name: view.name,
          definition: view.definition,
        })),
        routines,
        functions,
        procedures,
      },
    ],
  };
}

function toCoreTableSnapshot(
  schemaName: string,
  table: DbCopilotSchemaSnapshot["tables"][number]
): SchemaSnapshot["schemas"][number]["tables"][number] {
  const constraints = (table.constraints ?? []).map((constraint) => ({
    name: constraint.name,
    type: constraint.type,
    columns: [...constraint.columns],
    definition: constraint.definition,
  }));

  if (
    table.primaryKey.length > 0 &&
    !constraints.some((constraint) => normalizeConstraintType(constraint.type) === "PRIMARY KEY")
  ) {
    constraints.push({
      name: `${table.name}_pkey`,
      type: "PRIMARY KEY",
      columns: [...table.primaryKey],
      definition: null,
    });
  }

  return {
    name: table.name,
    rowCount: table.rowCount ?? null,
    tableSizeMB: null,
    columns: table.columns.map((column) => ({
      name: column.name,
      dataType: column.type,
      nullable: column.nullable,
      default: column.default ?? null,
    })),
    constraints,
    foreignKeys: table.foreignKeys.map((foreignKey, index) => ({
      name:
        foreignKey.name && foreignKey.name.trim().length > 0
          ? foreignKey.name
          : `${table.name}_fk_${index + 1}`,
      columns: [...foreignKey.columns],
      referencedSchema: foreignKey.references.schema || schemaName,
      referencedTable: foreignKey.references.table,
      referencedColumns: [...foreignKey.references.columns],
      onUpdate: foreignKey.onUpdate ?? null,
      onDelete: foreignKey.onDelete ?? null,
    })),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      columns: [...index.columns],
      unique: index.unique,
      primary: index.primary ?? false,
      method: index.method || null,
      predicate: null,
    })),
  };
}

function toCoreRoutine(
  routine: NonNullable<DbCopilotSchemaSnapshot["routines"]>[number]
): SchemaSnapshot["schemas"][number]["routines"][number] {
  return {
    name: routine.name,
    kind: routine.kind || "function",
    signature: routine.signature,
    returnType: routine.returnType,
    language: routine.language,
    definition: routine.definition ?? null,
  };
}

function normalizeConstraintType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function runExplainability(
  input: DbCopilotOrchestratorInput,
  outputs: DbCopilotAgentOutputs
): DbCopilotExplainabilityOutput {
  const ddl = outputs.ddl;
  const perf = outputs.performance;
  const risk = outputs.risk;
  const lines: string[] = [
    "# Summary",
    `- Intent: ${input.user_request || "Optimize query"}`,
    "",
    "## Why These Changes",
  ];
  if (perf?.index_recommendations.length) {
    lines.push(`- Add index on ${perf.index_recommendations[0].table} to reduce filter cost.`);
  } else {
    lines.push("- Review predicates to align with existing indexes.");
  }
  lines.push("", "## Expected Impact");
  lines.push(`- Lock risk: ${risk?.lock_contention_risk ?? "unknown"}`);
  lines.push("", "## Tradeoffs & Alternatives");
  lines.push(`- ${perf?.risk_summary ?? "Index adds write overhead."}`);
  lines.push("", "## How to Roll Back");
  lines.push(ddl?.down_sql ? `- ${ddl.down_sql}` : "- Drop added indexes.");
  lines.push("", "## Notes (Engine Specific)");
  lines.push(`- ${input.db_engine}: follow policy guidelines for index creation.`);
  return { markdown: lines.join("\n") };
}

function mergeOutputs(
  input: DbCopilotOrchestratorInput,
  outputs: DbCopilotAgentOutputs
): DbCopilotOptimizationPlan["merged"] {
  const ddl = outputs.ddl;
  const risk = outputs.risk;
  const governance = outputs.governance;
  const riskImpact = buildRiskImpactState(risk, governance);
  const policyAllowsExecution = riskImpact ? !riskImpact.requiresManualReview : false;
  const policyReason = riskImpact?.requiresManualReviewReason ?? null;
  const sqlPreview: DbCopilotSqlPreviewState | null = ddl
    ? {
        upSql: ddl.up_sql,
        downSql: ddl.down_sql,
        mode: input.execution_mode ? "execution" : "readOnly",
        policyAllowsExecution,
        policyReason,
      }
    : null;
  return {
    sql_preview: sqlPreview,
    risk_impact: riskImpact,
    explanation_markdown: outputs.explainability?.markdown ?? null,
  };
}

function buildRiskImpactState(
  risk?: DbCopilotRiskOutput,
  governance?: DbCopilotGovernanceOutput
): DbCopilotRiskImpactState | null {
  if (!risk && !governance) {
    return null;
  }
  const policyStatus = governance
    ? governance.compliant
      ? "Compliant"
      : "Non-compliant"
    : "Unknown";
  const policyViolations = governance?.violations ?? [];
  const policyViolationSummary = governance
    ? policyViolations.length
      ? policyViolations.map((entry) => formatGovernanceViolation(entry)).join("; ")
      : "None"
    : "Unknown";
  const riskGate = risk?.final_gate ?? null;
  const riskGateRequiresAction = Boolean(riskGate && riskGate !== "approve");
  const requiresManualReview =
    policyStatus === "Non-compliant" ||
    Boolean(risk?.requires_manual_review) ||
    riskGateRequiresAction;
  const reasonParts: string[] = [];
  if (policyStatus === "Non-compliant") {
    const violationDetails = policyViolations.length
      ? policyViolations.map((entry) => formatGovernanceViolation(entry)).join("; ")
      : "Policy violations detected.";
    reasonParts.push(`Policy violations: ${violationDetails}`);
  }
  if (riskGateRequiresAction && riskGate) {
    const gateLabel = titleCase(riskGate);
    const guidance =
      riskGate === "reject"
        ? "Execution blocked."
        : "Revise required before execution.";
    reasonParts.push(`Risk gate: ${gateLabel}. ${guidance}`);
  } else if (risk?.requires_manual_review) {
    reasonParts.push("Manual review required.");
  }
  const reason = reasonParts.length ? reasonParts.join(" ") : null;
  const summaryBase: Array<{ label: string; value: string }> = [
    {
      label: "Breaking changes",
      value: risk?.breaking_changes.length ? "Yes" : "None",
    },
    {
      label: "Lock contention risk",
      value: risk?.lock_contention_risk ? titleCase(risk.lock_contention_risk) : "Unknown",
    },
    {
      label: "Migration window friendly",
      value: risk?.migration_window_friendly ? "Yes" : "No",
    },
    {
      label: "Data loss risk",
      value: risk?.data_loss_risk ? titleCase(risk.data_loss_risk) : "Unknown",
    },
    {
      label: "Mitigations",
      value: risk?.mitigations.length ? risk.mitigations.join("; ") : "None",
    },
    {
      label: "Final gate",
      value: risk?.final_gate ? titleCase(risk.final_gate) : "Unknown",
    },
    {
      label: "Policy",
      value: policyStatus,
    },
    {
      label: "Policy violations",
      value: policyViolationSummary,
    },
  ];
  const summary = appendRollbackPlanToRiskSummary(summaryBase, risk?.rollback_plan);
  return {
    requiresManualReview,
    requiresManualReviewReason: reason ?? undefined,
    summary,
  };
}

function formatGovernanceViolation(
  violation: DbCopilotGovernanceOutput["violations"][number]
): string {
  const detail = [violation.object, violation.detail].filter(Boolean).join(": ");
  return detail ? `${violation.rule} (${detail})` : violation.rule;
}

function buildLogEntry(
  base: Date,
  offset: number,
  source: DbCopilotLogSource,
  message: string
): DbCopilotLogEntry {
  const timestamp = formatTimestamp(new Date(base.getTime() + offset * 1000));
  return {
    id: `${timestamp}-${source}-s${offset + 1}`,
    timestamp,
    source,
    message,
  };
}

function buildMissingContextLogs(
  intent: DbCopilotIntent,
  input: DbCopilotOrchestratorInput,
  missing: string[]
): DbCopilotLogEntry[] {
  const timestampBase = input.now ?? new Date();
  return [
    buildLogEntry(
      timestampBase,
      0,
      "orchestrator",
      `Detected intent ${intent}.`
    ),
    buildLogEntry(
      timestampBase,
      1,
      "orchestrator",
      `Missing context: ${missing.join(", ")}.`
    ),
  ];
}

function formatTimestamp(value: Date): string {
  const hours = value.getHours().toString().padStart(2, "0");
  const minutes = value.getMinutes().toString().padStart(2, "0");
  const seconds = value.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function buildMissingContextAuditLogs(
  intent: DbCopilotIntent,
  input: DbCopilotOrchestratorInput,
  missing: string[],
  sessionId: string
): DbCopilotAuditLogEntry[] {
  const timestamp = new Date();
  return [
    buildAuditLogEntry({
      timestamp,
      sessionId,
      agent: "orchestrator",
      message: `Detected intent ${intent}.`,
      input: {
        user_request: input.user_request,
        db_engine: input.db_engine,
        connection_label: input.connection_label,
        execution_mode: input.execution_mode,
        policies: input.policies,
        query_text: input.query_text ?? null,
        explain_plan: input.explain_plan ?? null,
      },
      output: { intent },
      durationMs: 0,
    }),
    buildAuditLogEntry({
      timestamp,
      sessionId,
      agent: "orchestrator",
      message: `Missing context: ${missing.join(", ")}.`,
      input: { missing_context: missing },
      output: { blocked: true },
      durationMs: 0,
    }),
  ];
}

function buildAuditLogEntry(input: {
  timestamp: Date;
  sessionId: string;
  agent: DbCopilotLogSource;
  message: string;
  input: unknown;
  output: unknown;
  durationMs: number;
}): DbCopilotAuditLogEntry {
  const inputRedacted = redactLogPayload(input.input);
  const outputRedacted = redactLogPayload(input.output);
  const inputHash = hashPayload(inputRedacted);
  const outputHash = hashPayload(outputRedacted);
  const tokensIn = estimateTokens(inputRedacted);
  const tokensOut = estimateTokens(outputRedacted);
  const totalTokens = tokensIn + tokensOut;
  const creditsEstimate = estimateCreditsFromTokens(totalTokens);

  return {
    id: `${input.timestamp.toISOString()}-${input.agent}-${input.sessionId}`,
    timestamp: input.timestamp.toISOString(),
    agent: input.agent,
    message: input.message,
    input_redacted: inputRedacted,
    output_redacted: outputRedacted,
    input_hash: inputHash,
    output_hash: outputHash,
    tokens_estimate: {
      input: tokensIn,
      output: tokensOut,
      total: totalTokens,
    },
    credits_estimate: creditsEstimate,
    duration_ms: input.durationMs,
    meter: {
      ai_tokens_in: tokensIn,
      ai_tokens_out: tokensOut,
      ai_cost_estimate_usd: 0,
      credits_used: creditsEstimate,
    },
    session_id: input.sessionId,
  };
}

function createLogSessionId(timestamp: Date): string {
  const datePart = timestamp.toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).slice(2, 10);
  return `dbcopilot-${datePart}-${timestamp.getTime()}-${random}`;
}

function redactLogPayload(value: unknown, path: string[] = []): unknown {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  const key = path[path.length - 1] ?? "";

  if (typeof value === "string") {
    if (shouldRedactKey(key)) {
      return buildRedactedSummary(value);
    }
    if (value.length > 180) {
      return {
        truncated: true,
        length: value.length,
        preview: value.slice(0, 140),
        hash: hashPayload(value),
      };
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (shouldRedactKey(key)) {
      return buildRedactedSummary(value);
    }
    return value.map((item, index) => redactLogPayload(item, [...path, `${index}`]));
  }

  if (typeof value === "object") {
    if (isSchemaSnapshot(value)) {
      return summarizeSchemaSnapshot(value);
    }
    if (shouldRedactKey(key)) {
      return buildRedactedSummary(value);
    }
    const record: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      record[entryKey] = redactLogPayload(entryValue, [...path, entryKey]);
    }
    return record;
  }

  return value;
}

function shouldRedactKey(key: string): boolean {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase();
  return (
    normalized.includes("sql") ||
    normalized.includes("query") ||
    normalized.includes("plan") ||
    normalized.includes("schema") ||
    normalized.includes("connection") ||
    normalized.includes("statement") ||
    normalized.includes("migration") ||
    normalized.includes("explain") ||
    normalized.includes("request") ||
    normalized.includes("ddl")
  );
}

function buildRedactedSummary(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return {
      redacted: true,
      length: value.length,
      hash: hashPayload(value),
    };
  }
  if (Array.isArray(value)) {
    return {
      redacted: true,
      count: value.length,
      hash: hashPayload(value),
    };
  }
  if (value && typeof value === "object") {
    return {
      redacted: true,
      keys: Object.keys(value as Record<string, unknown>).length,
      hash: hashPayload(value),
    };
  }
  return { redacted: true, hash: hashPayload(value) };
}

function isSchemaSnapshot(value: unknown): value is DbCopilotSchemaSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as DbCopilotSchemaSnapshot;
  return typeof record.schema === "string" && Array.isArray(record.tables);
}

function summarizeSchemaSnapshot(snapshot: DbCopilotSchemaSnapshot): Record<string, unknown> {
  const tableCount = snapshot.tables.length;
  let columnCount = 0;
  let foreignKeyCount = 0;
  snapshot.tables.forEach((table) => {
    columnCount += table.columns.length;
    foreignKeyCount += table.foreignKeys.length;
  });
  return {
    redacted: true,
    schema: snapshot.schema,
    tables: tableCount,
    columns: columnCount,
    foreign_keys: foreignKeyCount,
    hash: hashPayload(snapshot),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function estimateTokens(value: unknown): number {
  const text = stableStringify(value);
  if (!text) {
    return 0;
  }
  return Math.max(0, Math.ceil(text.length / 4));
}

function estimateCreditsFromTokens(tokens: number): number {
  if (tokens <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(tokens / 200));
}

function extractTableName(request: string): string | null {
  const normalized = request.toLowerCase();
  const match = normalized.match(/table\s+([a-z0-9_]+)/i);
  return match ? match[1] : null;
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

function buildMigrationYaml(input: {
  migrationId: string;
  title: string;
  transactional: boolean;
  engine: DbCopilotDbEngine;
  upSql: string;
  downSql: string;
  notes: string;
}): string {
  const lines: string[] = [
    `id: ${yamlQuote(input.migrationId)}`,
    `title: ${yamlQuote(input.title)}`,
    `engine: ${yamlQuote(input.engine)}`,
    `transactional: ${input.transactional ? "true" : "false"}`,
  ];

  if (input.upSql.trim()) {
    lines.push("up: |", ...indentBlock(input.upSql));
  } else {
    lines.push('up: ""');
  }

  if (input.downSql.trim()) {
    lines.push("down: |", ...indentBlock(input.downSql));
  } else {
    lines.push('down: ""');
  }

  if (input.notes.trim()) {
    lines.push(`notes: ${yamlQuote(input.notes)}`);
  }

  return lines.join("\n");
}

function indentBlock(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n").map((line) => `  ${line}`);
}

function yamlQuote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
