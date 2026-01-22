import type { PrismaClient } from "@prisma/client";
import type { PlanCode, PlanSubject } from "./plans";
import type { AiUsageState } from "../../../packages/shared/src/contracts";
import {
  CreditAction,
  CreditEstimate,
  ModelTier,
  estimateCredits,
} from "../../../packages/shared/src/credits";

export type CreditState = {
  dailyCredits: number;
  creditsRemaining: number;
  graceUsed: boolean;
  lastResetAt: Date;
  softLimit70Reached: boolean;
  softLimit90Reached: boolean;
  notice: string | null;
};

const DAILY_CREDITS_DEFAULT = Number(process.env.AI_DAILY_CREDITS ?? 100);
const GRACE_CREDITS_DEFAULT = Number(process.env.AI_GRACE_CREDITS ?? 20);
const MODEL_TIER_DEFAULT = (process.env.AI_MODEL_TIER ?? "standard") as ModelTier;

function resolveDailyCredits(): number {
  return Number.isFinite(DAILY_CREDITS_DEFAULT) && DAILY_CREDITS_DEFAULT > 0
    ? Math.floor(DAILY_CREDITS_DEFAULT)
    : 100;
}

function resolveGraceCredits(): number {
  return Number.isFinite(GRACE_CREDITS_DEFAULT) && GRACE_CREDITS_DEFAULT > 0
    ? Math.floor(GRACE_CREDITS_DEFAULT)
    : 20;
}

export function resolveModelTier(): ModelTier {
  if (MODEL_TIER_DEFAULT === "premium" || MODEL_TIER_DEFAULT === "enterprise") {
    return MODEL_TIER_DEFAULT;
  }
  return "standard";
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function buildCreditNotice(usageRatio: number): string | null {
  if (usageRatio >= 0.9) {
    return "Avoid interruptions - upgrade to Pro";
  }
  if (usageRatio >= 0.7) {
    return "You are getting strong value from SQLCortex";
  }
  return null;
}

function deriveUsageFlags(state: {
  dailyCredits: number;
  creditsRemaining: number;
}): { softLimit70Reached: boolean; softLimit90Reached: boolean; notice: string | null } {
  const dailyCredits = Math.max(0, state.dailyCredits);
  const used = Math.min(dailyCredits, Math.max(0, dailyCredits - state.creditsRemaining));
  const ratio = dailyCredits > 0 ? used / dailyCredits : 1;
  const softLimit70Reached = ratio >= 0.7;
  const softLimit90Reached = ratio >= 0.9;
  const notice = buildCreditNotice(ratio);
  return { softLimit70Reached, softLimit90Reached, notice };
}

export function resolveAiUsageState(input: {
  creditSystemEnabled: boolean;
  creditState: CreditState | null;
}): AiUsageState {
  if (!input.creditSystemEnabled || !input.creditState) {
    return { level: "normal" };
  }

  const { dailyCredits, creditsRemaining, graceUsed } = input.creditState;
  let level: AiUsageState["level"] = "normal";

  if (creditsRemaining <= 0 && graceUsed) {
    level = "blocked";
  } else {
    const used = Math.min(dailyCredits, Math.max(0, dailyCredits - creditsRemaining));
    const ratio = dailyCredits > 0 ? used / dailyCredits : 1;
    if (ratio >= 0.9) {
      level = "critical";
    } else if (ratio >= 0.7) {
      level = "warning";
    }
  }

  return {
    level,
    creditsRemaining,
    dailyCredits,
  };
}

function resolveSubjectFields(subject: PlanSubject) {
  return subject.subjectType === "ORG"
    ? { subjectType: "ORG" as const, orgId: subject.orgId, userId: null }
    : { subjectType: "USER" as const, orgId: null, userId: subject.userId };
}

export async function ensureEntitlement(
  prisma: PrismaClient,
  subject: PlanSubject,
  planCode: PlanCode,
  now: Date = new Date()
) {
  const planId = planCode.toLowerCase();
  const fields = resolveSubjectFields(subject);
  const existing = await prisma.orgEntitlement.findFirst({
    where: fields,
  });

  if (!existing) {
    return prisma.orgEntitlement.create({
      data: {
        ...fields,
        planId,
        proStartedAt: planId === "pro" ? now : null,
      },
    });
  }

  if (existing.planId !== planId) {
    const updated = await prisma.orgEntitlement.update({
      where: { id: existing.id },
      data: {
        planId,
        proStartedAt: planId === "pro" ? existing.proStartedAt ?? now : null,
      },
    });
    await recordCreditEvent(prisma, {
      orgId: updated.orgId,
      userId: updated.userId,
      eventType: "plan_change",
      creditsDelta: 0,
      meta: { previous_plan: existing.planId, new_plan: planId },
    });
    return updated;
  }

  if (planId === "pro" && !existing.proStartedAt) {
    return prisma.orgEntitlement.update({
      where: { id: existing.id },
      data: { proStartedAt: now },
    });
  }

  return existing;
}

export async function getCreditState(
  prisma: PrismaClient,
  subject: PlanSubject,
  now: Date = new Date()
): Promise<CreditState> {
  const fields = resolveSubjectFields(subject);
  const dailyCredits = resolveDailyCredits();
  const todayStart = startOfUtcDay(now);

  const existing = await prisma.orgAiCredit.findFirst({ where: fields });
  if (!existing) {
    const created = await prisma.orgAiCredit.create({
      data: {
        ...fields,
        dailyCredits,
        creditsRemaining: dailyCredits,
        graceUsed: false,
        lastResetAt: todayStart,
      },
    });
    await recordCreditEvent(prisma, {
      orgId: created.orgId,
      userId: created.userId,
      eventType: "reset",
      creditsDelta: dailyCredits,
      meta: { daily_credits: dailyCredits, reason: "initial" },
    });

    const usageFlags = deriveUsageFlags({
      dailyCredits,
      creditsRemaining: dailyCredits,
    });
    return {
      dailyCredits,
      creditsRemaining: dailyCredits,
      graceUsed: false,
      lastResetAt: created.lastResetAt,
      ...usageFlags,
    };
  }

  if (existing.lastResetAt < todayStart) {
    const updated = await prisma.orgAiCredit.update({
      where: { id: existing.id },
      data: {
        dailyCredits,
        creditsRemaining: dailyCredits,
        lastResetAt: todayStart,
      },
    });
    await recordCreditEvent(prisma, {
      orgId: updated.orgId,
      userId: updated.userId,
      eventType: "reset",
      creditsDelta: dailyCredits - existing.creditsRemaining,
      meta: {
        daily_credits: dailyCredits,
        previous_remaining: existing.creditsRemaining,
        reason: "daily_reset",
      },
    });
    const usageFlags = deriveUsageFlags({
      dailyCredits,
      creditsRemaining: dailyCredits,
    });
    return {
      dailyCredits,
      creditsRemaining: dailyCredits,
      graceUsed: updated.graceUsed,
      lastResetAt: updated.lastResetAt,
      ...usageFlags,
    };
  }

  const usageFlags = deriveUsageFlags({
    dailyCredits: existing.dailyCredits,
    creditsRemaining: existing.creditsRemaining,
  });
  return {
    dailyCredits: existing.dailyCredits,
    creditsRemaining: existing.creditsRemaining,
    graceUsed: existing.graceUsed,
    lastResetAt: existing.lastResetAt,
    ...usageFlags,
  };
}

export async function applyGraceCredits(
  prisma: PrismaClient,
  subject: PlanSubject,
  current: CreditState
): Promise<CreditState> {
  if (current.creditsRemaining > 0 || current.graceUsed) {
    return current;
  }

  const graceCredits = resolveGraceCredits();
  const fields = resolveSubjectFields(subject);
  const updated = await prisma.orgAiCredit.updateMany({
    where: fields,
    data: {
      creditsRemaining: graceCredits,
      graceUsed: true,
    },
  });

  if (updated.count > 0) {
    const record = await prisma.orgAiCredit.findFirst({ where: fields });
    if (record) {
      await recordCreditEvent(prisma, {
        orgId: record.orgId,
        userId: record.userId,
        eventType: "grace",
        creditsDelta: graceCredits,
        meta: { grace_credits: graceCredits },
      });
      const usageFlags = deriveUsageFlags({
        dailyCredits: record.dailyCredits,
        creditsRemaining: record.creditsRemaining,
      });
      return {
        dailyCredits: record.dailyCredits,
        creditsRemaining: record.creditsRemaining,
        graceUsed: record.graceUsed,
        lastResetAt: record.lastResetAt,
        ...usageFlags,
      };
    }
  }

  return current;
}

export async function deductCredits(
  prisma: PrismaClient,
  subject: PlanSubject,
  estimate: CreditEstimate,
  metadata: { action: CreditAction; modelTier?: ModelTier }
): Promise<CreditState | null> {
  const fields = resolveSubjectFields(subject);
  const record = await prisma.orgAiCredit.findFirst({ where: fields });
  if (!record) {
    return null;
  }

  const remaining = Math.max(0, record.creditsRemaining - estimate.total);
  const updated = await prisma.orgAiCredit.update({
    where: { id: record.id },
    data: { creditsRemaining: remaining },
  });

  await recordCreditEvent(prisma, {
    orgId: updated.orgId,
    userId: updated.userId,
    eventType: "usage",
    creditsDelta: -estimate.total,
    meta: {
      action: metadata.action,
      model_tier: metadata.modelTier ?? resolveModelTier(),
      base: estimate.base,
      complexity: estimate.complexity,
      total: estimate.total,
      length_bucket: estimate.lengthBucket,
      query_complexity: estimate.queryComplexity,
    },
  });

  const usageFlags = deriveUsageFlags({
    dailyCredits: updated.dailyCredits,
    creditsRemaining: updated.creditsRemaining,
  });
  return {
    dailyCredits: updated.dailyCredits,
    creditsRemaining: updated.creditsRemaining,
    graceUsed: updated.graceUsed,
    lastResetAt: updated.lastResetAt,
    ...usageFlags,
  };
}

export function buildCreditEstimate(input: {
  action: CreditAction;
  sql: string;
  modelTier?: ModelTier;
}): CreditEstimate {
  return estimateCredits({
    action: input.action,
    sql: input.sql,
    modelTier: input.modelTier ?? resolveModelTier(),
  });
}

async function recordCreditEvent(
  prisma: PrismaClient,
  input: {
    orgId: string | null;
    userId: string | null;
    eventType: "reset" | "usage" | "grace" | "plan_change";
    creditsDelta: number;
    meta: Record<string, unknown>;
  }
) {
  await prisma.creditEvent.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      eventType: input.eventType,
      creditsDelta: input.creditsDelta,
      meta: input.meta,
    },
  });
}
