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
