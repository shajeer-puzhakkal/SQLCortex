import type { ImpactReport } from "./ImpactAnalyzer";
import type { LockImpact } from "./LockEstimator";
import type { MigrationDiff, MigrationDiffColumnChange } from "./MigrationDiffBuilder";
import type { SchemaSnapshot } from "../schema/SchemaTypes";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskScore = {
  score: number;
  level: RiskLevel;
  explanation: string[];
};

export type RiskScorerEnvironment = "dev" | "staging" | "prod";

export type RiskScorerInput = {
  migrationDiff: MigrationDiff;
  impactReport: ImpactReport;
  lockImpact: LockImpact;
  environment: RiskScorerEnvironment;
  snapshotBefore?: SchemaSnapshot | null;
};

type TableFootprintSignal = {
  score: number;
  tier: 0 | 1 | 2 | 3 | 4;
  maxTableSizeMB: number;
  maxRows: number;
};

type DependencySignal = {
  score: number;
  highDependency: boolean;
};

const LOCK_SCORE_BY_SEVERITY: Record<LockImpact["estimatedLockSeverity"], number> = {
  LOW: 5,
  MEDIUM: 12,
  HIGH: 20,
};

const ENVIRONMENT_SCORE: Record<RiskScorerEnvironment, number> = {
  dev: 0,
  staging: 5,
  prod: 10,
};

export function scoreMigrationRisk(input: RiskScorerInput): RiskScore {
  const explanation: string[] = [];

  const dependencySignal = buildDependencySignal(input.impactReport);
  const lockScore = LOCK_SCORE_BY_SEVERITY[input.lockImpact.estimatedLockSeverity];
  const rewriteScore = input.lockImpact.rewriteRequired ? 20 : 0;
  const tableFootprint = buildTableFootprintSignal(
    input.migrationDiff,
    input.snapshotBefore,
    input.lockImpact.estimatedRowsTouched
  );
  const environmentScore = ENVIRONMENT_SCORE[input.environment];

  let score =
    dependencySignal.score + lockScore + rewriteScore + tableFootprint.score + environmentScore;

  if (input.impactReport.brokenObjects.length > 0) {
    explanation.push(
      `Dependency breakage detected (${input.impactReport.brokenObjects.length} broken objects).`
    );
  } else if (input.impactReport.directImpact.length > 0 || input.impactReport.indirectImpact.length > 0) {
    explanation.push(
      `Dependency impact detected (${input.impactReport.directImpact.length} direct, ${input.impactReport.indirectImpact.length} indirect).`
    );
  } else {
    explanation.push("No dependency breakage detected.");
  }

  explanation.push(`Lock severity is ${input.lockImpact.estimatedLockSeverity}.`);
  if (input.lockImpact.rewriteRequired) {
    explanation.push("Full table rewrite is required.");
  }

  if (tableFootprint.tier >= 3) {
    explanation.push(
      `Large table footprint detected (max ${formatNumber(tableFootprint.maxRows)} rows, ${formatNumber(tableFootprint.maxTableSizeMB)} MB).`
    );
  } else if (tableFootprint.tier >= 1) {
    explanation.push(
      `Moderate table footprint detected (max ${formatNumber(tableFootprint.maxRows)} rows, ${formatNumber(tableFootprint.maxTableSizeMB)} MB).`
    );
  }

  if (input.environment === "prod") {
    explanation.push("Production environment increases risk sensitivity.");
  } else if (input.environment === "staging") {
    explanation.push("Staging environment adds moderate operational risk.");
  }

  if (isMetadataOnlyChange(input.migrationDiff) && !input.lockImpact.rewriteRequired) {
    // Acceptance criterion: metadata-only changes should stay low.
    score = Math.min(score, 24);
    explanation.push("Change is metadata-only; risk is capped to LOW.");
  }

  if (dependencySignal.highDependency && input.lockImpact.rewriteRequired) {
    // Acceptance criterion: high dependency + rewrite must be HIGH/CRITICAL.
    score = Math.max(score, input.environment === "prod" ? 85 : 75);
    explanation.push("High dependency impact combined with rewrite requirement elevates risk.");
  }

  if (
    dependencySignal.highDependency &&
    input.lockImpact.rewriteRequired &&
    input.lockImpact.estimatedLockSeverity === "HIGH" &&
    (input.environment === "prod" || tableFootprint.tier >= 3)
  ) {
    score = Math.max(score, 90);
    explanation.push("Combined lock, rewrite, and dependency signals push risk to CRITICAL.");
  }

  const normalizedScore = clamp(Math.round(score), 0, 100);
  return {
    score: normalizedScore,
    level: scoreToLevel(normalizedScore),
    explanation,
  };
}

function buildDependencySignal(report: ImpactReport): DependencySignal {
  const brokenCount = report.brokenObjects.length;
  const directCount = report.directImpact.length;
  const indirectCount = report.indirectImpact.length;

  const score = clamp(brokenCount * 8 + directCount * 2 + indirectCount, 0, 40);
  const highDependency =
    brokenCount >= 3 ||
    directCount >= 8 ||
    (brokenCount >= 1 && directCount >= 4) ||
    (brokenCount >= 1 && indirectCount >= 8);

  return { score, highDependency };
}

function buildTableFootprintSignal(
  migrationDiff: MigrationDiff,
  snapshotBefore: SchemaSnapshot | null | undefined,
  estimatedRowsTouched: number
): TableFootprintSignal {
  const refs = collectAffectedTableRefs(migrationDiff);
  let maxRows = 0;
  let maxTableSizeMB = 0;

  if (snapshotBefore) {
    const tableIndex = buildTableFootprintIndex(snapshotBefore);
    for (const ref of refs) {
      const key = tableKey(ref.schemaName, ref.tableName);
      const footprint = tableIndex.get(key);
      if (!footprint) {
        continue;
      }
      maxRows = Math.max(maxRows, footprint.rowCount);
      maxTableSizeMB = Math.max(maxTableSizeMB, footprint.tableSizeMB);
    }
  }

  maxRows = Math.max(maxRows, sanitizeNumber(estimatedRowsTouched));

  if (maxTableSizeMB >= 10_240 || maxRows >= 10_000_000) {
    return { score: 10, tier: 4, maxRows, maxTableSizeMB };
  }
  if (maxTableSizeMB >= 2_048 || maxRows >= 1_000_000) {
    return { score: 7, tier: 3, maxRows, maxTableSizeMB };
  }
  if (maxTableSizeMB >= 512 || maxRows >= 100_000) {
    return { score: 4, tier: 2, maxRows, maxTableSizeMB };
  }
  if (maxTableSizeMB > 0 || maxRows > 0) {
    return { score: 2, tier: 1, maxRows, maxTableSizeMB };
  }
  return { score: 0, tier: 0, maxRows, maxTableSizeMB };
}

function collectAffectedTableRefs(migrationDiff: MigrationDiff): Array<{ schemaName: string; tableName: string }> {
  const refs = new Map<string, { schemaName: string; tableName: string }>();
  const pushRef = (schemaName: string, tableName: string): void => {
    const key = tableKey(schemaName, tableName);
    refs.set(key, {
      schemaName: normalizeIdentifier(schemaName),
      tableName: normalizeIdentifier(tableName),
    });
  };

  for (const tableName of migrationDiff.tablesAdded) {
    const ref = parseQualifiedTableName(tableName);
    if (ref) {
      pushRef(ref.schemaName, ref.tableName);
    }
  }
  for (const tableName of migrationDiff.tablesRemoved) {
    const ref = parseQualifiedTableName(tableName);
    if (ref) {
      pushRef(ref.schemaName, ref.tableName);
    }
  }

  for (const change of migrationDiff.columnsAdded) {
    pushRef(change.schemaName, change.tableName);
  }
  for (const change of migrationDiff.columnsRemoved) {
    pushRef(change.schemaName, change.tableName);
  }
  for (const change of migrationDiff.columnsAltered) {
    pushRef(change.schemaName, change.tableName);
  }
  for (const change of migrationDiff.indexesAdded) {
    pushRef(change.schemaName, change.tableName);
  }
  for (const change of migrationDiff.indexesRemoved) {
    pushRef(change.schemaName, change.tableName);
  }
  for (const change of migrationDiff.constraintsChanged) {
    pushRef(change.schemaName, change.tableName);
  }

  return Array.from(refs.values());
}

function buildTableFootprintIndex(
  snapshotBefore: SchemaSnapshot
): Map<string, { rowCount: number; tableSizeMB: number }> {
  const index = new Map<string, { rowCount: number; tableSizeMB: number }>();
  for (const schema of snapshotBefore.schemas) {
    for (const table of schema.tables) {
      index.set(tableKey(schema.name, table.name), {
        rowCount: sanitizeNumber(table.rowCount),
        tableSizeMB: sanitizeNumber(table.tableSizeMB),
      });
    }
  }
  return index;
}

function isMetadataOnlyChange(migrationDiff: MigrationDiff): boolean {
  const hasAnyChange =
    migrationDiff.tablesAdded.length > 0 ||
    migrationDiff.tablesRemoved.length > 0 ||
    migrationDiff.columnsAdded.length > 0 ||
    migrationDiff.columnsRemoved.length > 0 ||
    migrationDiff.columnsAltered.length > 0 ||
    migrationDiff.indexesAdded.length > 0 ||
    migrationDiff.indexesRemoved.length > 0 ||
    migrationDiff.constraintsChanged.length > 0;
  if (!hasAnyChange) {
    return false;
  }

  if (migrationDiff.tablesAdded.length > 0 || migrationDiff.tablesRemoved.length > 0) {
    return false;
  }
  if (migrationDiff.columnsAdded.length > 0 || migrationDiff.columnsRemoved.length > 0) {
    return false;
  }
  if (migrationDiff.columnsAltered.some(hasColumnTypeChanged)) {
    return false;
  }
  if (
    migrationDiff.constraintsChanged.some(
      (change) => change.source === "foreignKey" || change.kind !== "added"
    )
  ) {
    return false;
  }

  return true;
}

function hasColumnTypeChanged(change: MigrationDiffColumnChange): boolean {
  if (!change.previous || !change.next) {
    return true;
  }
  return normalizeDataType(change.previous.dataType) !== normalizeDataType(change.next.dataType);
}

function normalizeDataType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseQualifiedTableName(value: string): { schemaName: string; tableName: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }
  return {
    schemaName: normalizeIdentifier(trimmed.slice(0, separatorIndex)),
    tableName: normalizeIdentifier(trimmed.slice(separatorIndex + 1)),
  };
}

function tableKey(schemaName: string, tableName: string): string {
  return `${normalizeIdentifier(schemaName)}.${normalizeIdentifier(tableName)}`;
}

function sanitizeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
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

function scoreToLevel(score: number): RiskLevel {
  if (score >= 85) {
    return "CRITICAL";
  }
  if (score >= 60) {
    return "HIGH";
  }
  if (score >= 30) {
    return "MEDIUM";
  }
  return "LOW";
}

function formatNumber(value: number): string {
  return Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.round(value)));
}
