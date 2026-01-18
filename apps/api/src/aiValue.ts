import type { PrismaClient } from "@prisma/client";
import type { PlanSubject } from "./plans";
import type { CreditAction } from "../../../packages/shared/src/credits";

const DEFAULT_COST_PER_HOUR = Number(process.env.AI_VALUE_COST_PER_HOUR ?? 30);

const MINUTES_SAVED_BY_ACTION: Record<string, number> = {
  explain: 2,
  "index-suggest": 5,
  optimize: 8,
  rewrite: 8,
  "schema-analysis": 6,
  analyze: 6,
  "risk-check": 4,
};

function resolveCostPerHour(): number {
  return Number.isFinite(DEFAULT_COST_PER_HOUR) && DEFAULT_COST_PER_HOUR > 0
    ? DEFAULT_COST_PER_HOUR
    : 30;
}

function resolveMinutesSaved(action: CreditAction): number {
  return MINUTES_SAVED_BY_ACTION[action] ?? 2;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function resolveSubjectFields(subject: PlanSubject) {
  return subject.subjectType === "ORG"
    ? { orgId: subject.orgId, userId: null }
    : { orgId: null, userId: subject.userId };
}

export async function recordAiValueDaily(
  prisma: PrismaClient,
  subject: PlanSubject,
  action: CreditAction,
  now: Date = new Date()
) {
  const minutesSaved = resolveMinutesSaved(action);
  const costPerHour = resolveCostPerHour();
  const costSaved = (minutesSaved / 60) * costPerHour;
  const date = startOfUtcDay(now);
  const subjectFields = resolveSubjectFields(subject);

  const where =
    subject.subjectType === "ORG"
      ? { orgId_date: { orgId: subject.orgId, date } }
      : { userId_date: { userId: subject.userId, date } };

  await prisma.aiValueDaily.upsert({
    where,
    create: {
      ...subjectFields,
      date,
      actionsCount: 1,
      estimatedMinutesSaved: minutesSaved,
      estimatedCostSavedUsd: costSaved,
    },
    update: {
      actionsCount: { increment: 1 },
      estimatedMinutesSaved: { increment: minutesSaved },
      estimatedCostSavedUsd: { increment: costSaved },
    },
  });
}
