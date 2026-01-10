import { ErrorResponse, makeError } from "./contracts";

export type AiSqlAction = "explain" | "optimize" | "index-suggest" | "risk-check";

export type AiSqlPayload = {
  sql_text: string;
  schema: Record<string, unknown>;
  indexes: Record<string, unknown>;
  explain_output: string;
  db_engine: string;
  project_id: string;
  user_intent?: string | null;
};

export type AiSqlResponse = {
  summary: string;
  findings: string[];
  recommendations: string[];
  risk_level: "low" | "medium" | "high";
  meta: { provider: string; model: string; latency_ms: number };
};

export type AiServiceError = {
  status: number;
  payload: ErrorResponse;
};

function resolveAiServicesBaseUrl(): string {
  const defaultAiPortRaw = Number(process.env.ANALYZER_PORT ?? 8000);
  const defaultAiPort =
    Number.isFinite(defaultAiPortRaw) && defaultAiPortRaw > 0 ? defaultAiPortRaw : 8000;
  return (
    process.env.AI_SERVICES_BASE_URL ??
    process.env.ANALYZER_BASE_URL ??
    process.env.ANALYZER_URL ??
    `http://ai-services:${defaultAiPort}`
  );
}

function resolveAiServicesTimeoutMs(): number {
  const aiTimeoutMsEnv = Number(
    process.env.AI_SERVICES_TIMEOUT_MS ??
      process.env.AI_TIMEOUT_MS ??
      process.env.ANALYZER_TIMEOUT_MS ??
      process.env.ANALYZER_TIMEOUT ??
      8000
  );
  return Number.isFinite(aiTimeoutMsEnv) && aiTimeoutMsEnv > 0 ? aiTimeoutMsEnv : 8000;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeAiSqlResponse(payload: unknown): AiSqlResponse {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const summary = typeof record.summary === "string" ? record.summary : "";
  const findings = normalizeStringArray(record.findings);
  const recommendations = normalizeStringArray(record.recommendations);
  const risk =
    record.risk_level === "low" || record.risk_level === "medium" || record.risk_level === "high"
      ? record.risk_level
      : "medium";

  const metaRecord =
    record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : {};
  const provider = typeof metaRecord.provider === "string" ? metaRecord.provider : "unknown";
  const model = typeof metaRecord.model === "string" ? metaRecord.model : "unknown";
  const latencyMs =
    typeof metaRecord.latency_ms === "number" && Number.isFinite(metaRecord.latency_ms)
      ? metaRecord.latency_ms
      : 0;

  return {
    summary,
    findings,
    recommendations,
    risk_level: risk,
    meta: { provider, model, latency_ms: latencyMs },
  };
}

function extractAiServiceDetail(
  payload: unknown
): { code?: string; message?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (detail && typeof detail === "object") {
    const detailRecord = detail as Record<string, unknown>;
    return {
      code: typeof detailRecord.code === "string" ? detailRecord.code : undefined,
      message: typeof detailRecord.message === "string" ? detailRecord.message : undefined,
    };
  }
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function mapAiServiceError(status: number, payload: unknown): ErrorResponse {
  const detail = extractAiServiceDetail(payload);
  const detailCode = detail?.code ?? null;
  const message = detail?.message ?? "AI service returned an error.";
  const details: Record<string, unknown> = { status };
  if (detailCode) {
    details.service_code = detailCode;
  }

  if (status === 400 || status === 422) {
    return makeError("INVALID_INPUT", message, details);
  }
  if (status === 504 || detailCode === "ai_timeout") {
    return makeError("ANALYZER_TIMEOUT", message, details);
  }
  return makeError("ANALYZER_ERROR", message, details);
}

export async function callAiSqlService(
  action: AiSqlAction,
  payload: AiSqlPayload
): Promise<AiSqlResponse> {
  const controller = new AbortController();
  const timeoutMs = resolveAiServicesTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const aiServicesBaseUrl = resolveAiServicesBaseUrl();

  try {
    const response = await fetch(`${aiServicesBaseUrl}/ai/sql/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responsePayload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw {
        status: response.status,
        payload: mapAiServiceError(response.status, responsePayload),
      } satisfies AiServiceError;
    }

    return normalizeAiSqlResponse(responsePayload);
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && "payload" in err) {
      throw err as AiServiceError;
    }

    if ((err as Error)?.name === "AbortError") {
      throw {
        status: 504,
        payload: makeError("ANALYZER_TIMEOUT", "AI request timed out.", {
          timeout_ms: timeoutMs,
        }),
      } satisfies AiServiceError;
    }

    throw {
      status: 502,
      payload: makeError("ANALYZER_ERROR", "Could not reach AI service.", {
        reason: err instanceof Error ? err.message : "unknown",
      }),
    } satisfies AiServiceError;
  } finally {
    clearTimeout(timeout);
  }
}
