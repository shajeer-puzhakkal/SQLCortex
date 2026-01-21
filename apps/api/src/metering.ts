import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { hashSql, normalizeSql, redactError } from "../../../packages/shared/src";
import type { ExplainMode, MeterEvent } from "../../../packages/shared/src/contracts";

type MeterEventInput = {
  orgId: string | null;
  projectId: string | null;
  userId: string | null;
  source: MeterEvent["source"];
  eventType: MeterEvent["eventType"];
  aiUsed: boolean;
  model?: string | null;
  tokensEstimated?: number | null;
  sql: string;
  durationMs: number;
  status: MeterEvent["status"];
  errorCode?: string | null;
  explainMode?: ExplainMode | null;
};

export async function recordMeterEvent(
  prisma: PrismaClient,
  input: MeterEventInput
): Promise<string | null> {
  const sqlHash = hashSql(normalizeSql(input.sql));
  const eventId = randomUUID();
  try {
    const createPromise = prisma.meterEvent.create({
      data: {
        id: eventId,
        timestamp: new Date(),
        orgId: input.orgId,
        projectId: input.projectId,
        userId: input.userId,
        source: input.source,
        eventType: input.eventType,
        aiUsed: input.aiUsed,
        model: input.model ?? null,
        tokensEstimated: input.tokensEstimated ?? null,
        sqlHash,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        status: input.status,
        errorCode: input.errorCode ?? null,
        explainMode: input.explainMode ?? null,
      },
    });
    createPromise.catch((err) => {
      console.error("Failed to record meter event", redactError(err));
    });
    return eventId;
  } catch (err) {
    console.error("Failed to record meter event", redactError(err));
    return null;
  }
}
