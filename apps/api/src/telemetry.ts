export type AnalysisTelemetry = {
  analysisId: string | null;
  projectId: string | null;
  userId: string | null;
  orgId: string | null;
  analyzerDurationMs: number | null;
  analyzerErrorCode: string | null;
  quotaDenied: boolean;
  rateLimited: boolean;
  llmUsed: boolean;
};

export type AiSqlTelemetry = {
  action: string;
  projectId: string | null;
  userId: string | null;
  orgId: string | null;
  llmUsed: boolean;
  blocked: boolean;
  reason: string | null;
  errorCode: string | null;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
};

export function logAnalysisTelemetry(entry: AnalysisTelemetry) {
  console.log(
    JSON.stringify({
      analysis_id: entry.analysisId,
      project_id: entry.projectId,
      user_id: entry.userId,
      org_id: entry.orgId,
      analyzer_duration_ms: entry.analyzerDurationMs,
      analyzer_error_code: entry.analyzerErrorCode,
      quota_denied: entry.quotaDenied,
      rate_limited: entry.rateLimited,
      llm_used: entry.llmUsed,
    })
  );
}

export function logAiSqlTelemetry(entry: AiSqlTelemetry) {
  console.log(
    JSON.stringify({
      event: "ai_sql",
      action: entry.action,
      project_id: entry.projectId,
      user_id: entry.userId,
      org_id: entry.orgId,
      llm_used: entry.llmUsed,
      blocked: entry.blocked,
      reason: entry.reason,
      error_code: entry.errorCode,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      latency_ms: entry.latencyMs ?? null,
    })
  );
}
