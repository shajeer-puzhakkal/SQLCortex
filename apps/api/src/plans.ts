import { PrismaClient } from "@prisma/client";

export type PlanCode = "FREE" | "PRO";

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  maxProjects: number;
  maxMembersPerOrg: number;
  analysesPerMonth: number;
  monthlyLlmCallLimit: number;
  historyRetentionDays: number;
  maxSqlLength: number;
  maxExplainJsonBytes: number;
  llmEnabled: boolean;
  apiRateLimitPerMin: number;
};

export const PLAN_DEFINITIONS: Record<PlanCode, PlanDefinition> = {
  FREE: {
    code: "FREE",
    name: "Free",
    maxProjects: 1,
    maxMembersPerOrg: 3,
    analysesPerMonth: 100,
    monthlyLlmCallLimit: 0,
    historyRetentionDays: 7,
    maxSqlLength: 20_000,
    maxExplainJsonBytes: 512 * 1024,
    llmEnabled: false,
    apiRateLimitPerMin: 60,
  },
  PRO: {
    code: "PRO",
    name: "Pro",
    maxProjects: 50,
    maxMembersPerOrg: 50,
    analysesPerMonth: 1_000,
    monthlyLlmCallLimit: 1_000,
    historyRetentionDays: 365,
    maxSqlLength: 200_000,
    maxExplainJsonBytes: 5 * 1024 * 1024,
    llmEnabled: true,
    apiRateLimitPerMin: 300,
  },
};

export function suggestedUpgradeForPlan(planCode: PlanCode): PlanCode | null {
  if (planCode === "FREE") {
    return "PRO";
  }
  return null;
}

let defaultPlansEnsured: Promise<void> | null = null;

export function ensureDefaultPlans(prisma: PrismaClient) {
  if (defaultPlansEnsured) {
    return defaultPlansEnsured;
  }

  const free = PLAN_DEFINITIONS.FREE;
  const pro = PLAN_DEFINITIONS.PRO;

  defaultPlansEnsured = (async () => {
    await prisma.plan.upsert({
      where: { code: free.code },
      update: {
        name: free.name,
        monthlyAnalysisLimit: free.analysesPerMonth,
        monthlyLlmCallLimit: free.monthlyLlmCallLimit,
      },
      create: {
        code: free.code,
        name: free.name,
        monthlyAnalysisLimit: free.analysesPerMonth,
        monthlyLlmCallLimit: free.monthlyLlmCallLimit,
      },
    });

    await prisma.plan.upsert({
      where: { code: pro.code },
      update: {
        name: pro.name,
        monthlyAnalysisLimit: pro.analysesPerMonth,
        monthlyLlmCallLimit: pro.monthlyLlmCallLimit,
      },
      create: {
        code: pro.code,
        name: pro.name,
        monthlyAnalysisLimit: pro.analysesPerMonth,
        monthlyLlmCallLimit: pro.monthlyLlmCallLimit,
      },
    });
  })();

  return defaultPlansEnsured;
}

export type PlanSubject =
  | { subjectType: "USER"; userId: string }
  | { subjectType: "ORG"; orgId: string };

export async function ensureSubscription(
  prisma: PrismaClient,
  subject: PlanSubject,
  planCode: PlanCode = "FREE"
) {
  const existing = await prisma.subscription.findFirst({
    where:
      subject.subjectType === "USER"
        ? { subjectType: "USER", userId: subject.userId }
        : { subjectType: "ORG", orgId: subject.orgId },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  await ensureDefaultPlans(prisma);
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) {
    throw new Error(`Plan '${planCode}' not found; ensureDefaultPlans must run first.`);
  }

  return prisma.subscription.create({
    data: {
      planId: plan.id,
      subjectType: subject.subjectType,
      userId: subject.subjectType === "USER" ? subject.userId : null,
      orgId: subject.subjectType === "ORG" ? subject.orgId : null,
    },
  });
}

export async function getPlanContext(prisma: PrismaClient, subject: PlanSubject) {
  await ensureDefaultPlans(prisma);

  const existing = await prisma.subscription.findFirst({
    where:
      subject.subjectType === "USER"
        ? { subjectType: "USER", userId: subject.userId }
        : { subjectType: "ORG", orgId: subject.orgId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });

  if (existing) {
    const planCodeRaw = existing.plan.code ?? "FREE";
    const planCode =
      planCodeRaw === "PRO" || planCodeRaw === "FREE" ? (planCodeRaw as PlanCode) : "FREE";

    return {
      subject,
      subscriptionId: existing.id,
      planCode,
      plan: PLAN_DEFINITIONS[planCode],
    };
  }

  const created = await ensureSubscription(prisma, subject, "FREE");
  const createdWithPlan = await prisma.subscription.findUnique({
    where: { id: created.id },
    include: { plan: true },
  });

  const planCodeRaw = createdWithPlan?.plan.code ?? "FREE";
  const planCode =
    planCodeRaw === "PRO" || planCodeRaw === "FREE" ? (planCodeRaw as PlanCode) : "FREE";

  return {
    subject,
    subscriptionId: created.id,
    planCode,
    plan: PLAN_DEFINITIONS[planCode],
  };
}
