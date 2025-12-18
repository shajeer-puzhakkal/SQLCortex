import { Prisma, PrismaClient } from "@prisma/client";
import { makeError } from "./contracts";
import type { PlanCode, PlanDefinition, PlanSubject } from "./plans";
import { suggestedUpgradeForPlan } from "./plans";

export function makePlanLimitExceededError(
  message: string,
  payload: { limit: number; used: number; plan: PlanCode; suggested_plan: PlanCode | null }
) {
  return makeError("PLAN_LIMIT_EXCEEDED", message, payload);
}

export function monthWindowUtc(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

export function countBytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function checkSqlAndExplainSizeLimits(
  plan: PlanDefinition,
  planCode: PlanCode,
  sql: string,
  explainJsonSerialized: string
) {
  if (sql.length > plan.maxSqlLength) {
    return makePlanLimitExceededError("SQL length exceeds plan limit.", {
      limit: plan.maxSqlLength,
      used: sql.length,
      plan: planCode,
      suggested_plan: suggestedUpgradeForPlan(planCode),
    });
  }

  const explainBytes = countBytes(explainJsonSerialized);
  if (explainBytes > plan.maxExplainJsonBytes) {
    return makePlanLimitExceededError("Explain JSON exceeds plan limit.", {
      limit: plan.maxExplainJsonBytes,
      used: explainBytes,
      plan: planCode,
      suggested_plan: suggestedUpgradeForPlan(planCode),
    });
  }

  return null;
}

export async function countProjectsForSubject(
  prisma: PrismaClient | Prisma.TransactionClient,
  subject: PlanSubject
) {
  if (subject.subjectType === "ORG") {
    return prisma.project.count({ where: { orgId: subject.orgId } });
  }
  return prisma.project.count({ where: { ownerUserId: subject.userId } });
}

export async function countOrgMembersAndPendingInvites(
  prisma: PrismaClient | Prisma.TransactionClient,
  orgId: string
) {
  const [members, invites] = await Promise.all([
    prisma.orgMember.count({ where: { orgId } }),
    prisma.orgInvite.count({
      where: {
        orgId,
        acceptedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
  ]);
  return { members, pendingInvites: invites, total: members + invites };
}

export async function getAnalysesUsedThisMonth(
  prisma: PrismaClient | Prisma.TransactionClient,
  subject: PlanSubject,
  now: Date = new Date()
) {
  const { start } = monthWindowUtc(now);

  const counter = await prisma.usageCounter.findFirst({
    where:
      subject.subjectType === "ORG"
        ? { subjectType: "ORG", orgId: subject.orgId, month: start }
        : { subjectType: "USER", userId: subject.userId, month: start },
  });

  return counter?.analysesCount ?? 0;
}

export async function incrementAnalysesThisMonth(
  prisma: PrismaClient | Prisma.TransactionClient,
  subject: PlanSubject,
  now: Date = new Date()
) {
  const { start } = monthWindowUtc(now);

  const existing = await prisma.usageCounter.findFirst({
    where:
      subject.subjectType === "ORG"
        ? { subjectType: "ORG", orgId: subject.orgId, month: start }
        : { subjectType: "USER", userId: subject.userId, month: start },
  });

  if (existing) {
    return prisma.usageCounter.update({
      where: { id: existing.id },
      data: { analysesCount: { increment: 1 } },
    });
  }

  return prisma.usageCounter.create({
    data: {
      subjectType: subject.subjectType,
      userId: subject.subjectType === "USER" ? subject.userId : null,
      orgId: subject.subjectType === "ORG" ? subject.orgId : null,
      month: start,
      analysesCount: 1,
      llmCallsCount: 0,
    },
  });
}
