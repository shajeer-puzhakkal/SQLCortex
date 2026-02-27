import { analyzeDependencyImpact, type ImpactReport } from "./ImpactAnalyzer";
import { estimateLockImpact, type LockImpact } from "./LockEstimator";
import {
  buildMigrationDiff,
  type MigrationDiff,
  type MigrationDiffBuildResult,
} from "./MigrationDiffBuilder";
import { generateRollbackPlan, type RollbackPlan } from "./RollbackGenerator";
import { scoreMigrationRisk, type RiskScore, type RiskScorerEnvironment } from "./RiskScorer";
import { generateSafeStrategy, type SafeStrategyPlan } from "./SafeStrategyGenerator";
import { buildSchemaGraph } from "../schema/buildSchemaGraph";
import type { SchemaSnapshot } from "../schema/SchemaTypes";

export type SafeMigrationSimulation = {
  statements: string[];
  appliedStatements: number;
  confidenceScore: number;
  confidenceLevel: "LOW" | "MEDIUM" | "HIGH";
  confidenceExplanation: string[];
  migrationDiff: MigrationDiff;
  impactReport: ImpactReport;
  lockImpact: LockImpact;
  riskScore: RiskScore;
  safeStrategy: SafeStrategyPlan;
  rollbackPlan: RollbackPlan;
};

export type SafeMigrationEngineInput = {
  ddlSql: string;
  snapshotBefore: SchemaSnapshot;
  environment: RiskScorerEnvironment;
  defaultSchema?: string;
};

export type SafeMigrationEngineResult = {
  ok: boolean;
  simulation: SafeMigrationSimulation | null;
  errors: string[];
};

export function runSafeMigrationEngine(input: SafeMigrationEngineInput): SafeMigrationEngineResult {
  if (!input.ddlSql.trim()) {
    return {
      ok: false,
      simulation: null,
      errors: ["No DDL SQL was provided for simulation."],
    };
  }

  try {
    const diffResult = buildMigrationDiff({
      snapshotBefore: input.snapshotBefore,
      ddlSql: input.ddlSql,
      defaultSchema: input.defaultSchema,
    });
    const schemaGraph = buildSchemaGraph(diffResult.snapshotBefore);
    const impactReport = analyzeDependencyImpact({
      migrationDiff: diffResult.migrationDiff,
      schemaGraph,
      snapshotBefore: diffResult.snapshotBefore,
    });
    const lockImpact = estimateLockImpact({
      migrationDiff: diffResult.migrationDiff,
      snapshotBefore: diffResult.snapshotBefore,
      statements: diffResult.statements,
      defaultSchema: input.defaultSchema,
    });
    const riskScore = scoreMigrationRisk({
      migrationDiff: diffResult.migrationDiff,
      impactReport,
      lockImpact,
      environment: input.environment,
      snapshotBefore: diffResult.snapshotBefore,
    });
    const safeStrategy = generateSafeStrategy({
      migrationDiff: diffResult.migrationDiff,
      riskScore,
      statements: diffResult.statements,
    });
    const rollbackPlan = generateRollbackPlan({
      migrationDiff: diffResult.migrationDiff,
    });
    const confidence = buildSimulationConfidence(diffResult, impactReport, lockImpact);

    return {
      ok: true,
      simulation: {
        statements: diffResult.statements,
        appliedStatements: diffResult.appliedStatements,
        confidenceScore: confidence.score,
        confidenceLevel: confidence.level,
        confidenceExplanation: confidence.explanation,
        migrationDiff: diffResult.migrationDiff,
        impactReport,
        lockImpact,
        riskScore,
        safeStrategy,
        rollbackPlan,
      },
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      simulation: null,
      errors: [toErrorMessage(error)],
    };
  }
}

function buildSimulationConfidence(
  diffResult: MigrationDiffBuildResult,
  impactReport: ImpactReport,
  lockImpact: LockImpact
): { score: number; level: "LOW" | "MEDIUM" | "HIGH"; explanation: string[] } {
  const totalStatements = diffResult.statements.length;
  const appliedStatements = Math.max(0, diffResult.appliedStatements);
  const diffChangeCount = countDiffChanges(diffResult.migrationDiff);
  const appliedRatio = totalStatements > 0 ? appliedStatements / totalStatements : 0;
  const explanation: string[] = [];

  if (totalStatements === 0) {
    return {
      score: 20,
      level: "LOW",
      explanation: ["DDL did not contain executable statements for simulation."],
    };
  }

  let score = 35 + Math.round(appliedRatio * 45);
  if (totalStatements <= 5) {
    score += 10;
  } else if (totalStatements >= 20) {
    score -= 8;
  }

  if (diffChangeCount === 0) {
    score -= 20;
    explanation.push("Simulation parsed SQL but produced no schema diff.");
  }
  if (lockImpact.rewriteRequired) {
    score -= 5;
    explanation.push("Rewrite-heavy operations reduce simulation certainty.");
  }

  const impactSignalCount =
    impactReport.directImpact.length +
    impactReport.indirectImpact.length +
    impactReport.brokenObjects.length;
  if (impactSignalCount >= 25) {
    score -= 5;
    explanation.push("Large dependency fanout increases uncertainty.");
  }

  explanation.unshift(
    `Applied ${appliedStatements}/${totalStatements} statement(s) in simulation.`,
    `Detected ${diffChangeCount} structural change(s).`
  );

  const normalized = clamp(score, 5, 99);
  return {
    score: normalized,
    level: confidenceScoreToLevel(normalized),
    explanation,
  };
}

function countDiffChanges(diff: MigrationDiff): number {
  return (
    diff.tablesAdded.length +
    diff.tablesRemoved.length +
    diff.columnsAdded.length +
    diff.columnsRemoved.length +
    diff.columnsAltered.length +
    diff.indexesAdded.length +
    diff.indexesRemoved.length +
    diff.constraintsChanged.length
  );
}

function confidenceScoreToLevel(value: number): "LOW" | "MEDIUM" | "HIGH" {
  if (value >= 80) {
    return "HIGH";
  }
  if (value >= 55) {
    return "MEDIUM";
  }
  return "LOW";
}

function clamp(value: number, minValue: number, maxValue: number): number {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "SafeMigrationEngine failed to run.";
}
