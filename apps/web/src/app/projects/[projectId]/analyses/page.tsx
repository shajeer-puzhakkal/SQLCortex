"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { MonacoEditorProps } from "@monaco-editor/react";

const MonacoEditor = dynamic<MonacoEditorProps>(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center rounded-2xl border border-black/10 bg-white/60 text-sm text-black/50">
      Loading editor...
    </div>
  ),
});

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const ACTIVE_PROJECT_KEY = "sqlcortex.activeProjectId";

type ApiError = { code: string; message: string; details?: Record<string, unknown> };

type Project = {
  id: string;
  name: string;
  org_id: string | null;
  owner_user_id: string | null;
};

type Finding = {
  code: string;
  title: string;
  severity: string;
  score: number;
  impact?: string | null;
  remediation?: string | null;
};

type IndexSuggestion = { table: string; columns: string[]; sql: string; reason: string };

type AnalyzerResult = {
  primary_bottleneck?: string | null;
  findings?: Finding[];
  suggested_indexes?: IndexSuggestion[];
  suggested_rewrite?: { title: string; sql?: string | null; rationale?: string | null } | null;
  anti_patterns?: string[];
  confidence?: { overall: number; missing_data: string[] };
};

type AnalysisResource = {
  id: string;
  status: string;
  sql: string;
  explain_json: unknown;
  result: AnalyzerResult | ApiError | null;
  project_id: string | null;
  user_id: string | null;
  org_id: string | null;
  created_at: string;
  updated_at: string;
};

const sampleSql = `SELECT customer_id, SUM(amount) AS total_spend
FROM payments
GROUP BY customer_id
ORDER BY total_spend DESC
LIMIT 20;`;

const sampleExplainJson = JSON.stringify(
  [
    {
      Plan: {
        "Node Type": "Aggregate",
        Strategy: "Hashed",
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "payments",
            Alias: "payments",
          },
        ],
      },
    },
  ],
  null,
  2
);

const severityStyles: Record<string, string> = {
  critical: "bg-rose-100 text-rose-700 border-rose-200",
  high: "bg-amber-100 text-amber-800 border-amber-200",
  medium: "bg-cyan-100 text-cyan-800 border-cyan-200",
  low: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const base = "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]";
  if (normalized === "completed" || normalized === "done") {
    return <span className={`${base} border-emerald-200 bg-emerald-50 text-emerald-700`}>Done</span>;
  }
  if (normalized === "queued") {
    return <span className={`${base} border-amber-200 bg-amber-50 text-amber-700`}>Queued</span>;
  }
  if (normalized === "error") {
    return <span className={`${base} border-rose-200 bg-rose-50 text-rose-700`}>Error</span>;
  }
  return <span className={`${base} border-black/10 bg-white text-black/70`}>{status}</span>;
}

function ErrorBanner({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const detailEntries =
    error.details && typeof error.details === "object"
      ? Object.entries(error.details)
      : [];

  const upgradeCopy =
    error.code === "PLAN_LIMIT_EXCEEDED" && error.details
      ? `Used ${String((error.details as Record<string, unknown>).used ?? "?")} / ${String(
          (error.details as Record<string, unknown>).limit ?? "?"
        )} on plan ${String((error.details as Record<string, unknown>).plan ?? "")}`
      : null;

  const retryCopy =
    error.code === "RATE_LIMITED" && error.details
      ? `Retry after ${String((error.details as Record<string, unknown>).retry_after_seconds ?? "?")}s`
      : null;

  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800 shadow-sm shadow-rose-200/60">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em]">{error.code}</p>
          <p className="mt-1 text-sm font-semibold">{error.message}</p>
          {upgradeCopy ? (
            <p className="mt-1 text-xs text-rose-700/80">
              {upgradeCopy} {String((error.details as Record<string, unknown>).suggested_plan ?? "")}
            </p>
          ) : null}
          {retryCopy ? <p className="mt-1 text-xs text-rose-700/80">{retryCopy}</p> : null}
        </div>
      </div>
      {detailEntries.length > 0 ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-white/60 px-3 py-2 text-[11px] text-rose-700/90">
          {JSON.stringify(error.details, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function HistoryList({
  analyses,
  selectedId,
  onSelect,
  loading,
}: {
  analyses: AnalysisResource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  return (
    <div className="rounded-3xl border border-black/10 bg-white/70 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-black/50">History</p>
          <p className="text-base font-semibold text-black">Recent analyses</p>
        </div>
        {loading ? <span className="text-xs text-black/50">Refreshing…</span> : null}
      </div>
      <div className="mt-4 space-y-2">
        {analyses.length === 0 ? (
          <p className="text-sm text-black/60">No analyses yet for this project.</p>
        ) : (
          analyses.map((analysis) => {
            const primary =
              analysis.status === "error"
                ? "Error"
                : (analysis.result as AnalyzerResult | null)?.primary_bottleneck ?? "No bottleneck logged";
            return (
              <button
                key={analysis.id}
                onClick={() => onSelect(analysis.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition hover:border-black/20 hover:shadow-sm hover:shadow-black/5 ${
                  selectedId === analysis.id
                    ? "border-cyan-500/50 bg-cyan-50/70 shadow-sm shadow-cyan-900/10"
                    : "border-black/10 bg-white/70"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <StatusPill status={analysis.status} />
                    <p className="text-sm font-semibold text-black">
                      {analysis.sql.length > 48 ? `${analysis.sql.slice(0, 48)}…` : analysis.sql}
                    </p>
                  </div>
                  <span className="text-[11px] text-black/50">
                    {new Date(analysis.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-xs text-black/60">{primary}</p>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function ResultView({
  analysis,
  loading,
}: {
  analysis: AnalysisResource | null;
  loading: boolean;
}) {
  const isErrorResult =
    analysis &&
    (analysis.status === "error" ||
      (analysis.result && typeof analysis.result === "object" && "code" in analysis.result));
  const errorPayload = isErrorResult ? (analysis?.result as ApiError | null) : null;
  const result = analysis && !isErrorResult ? (analysis.result as AnalyzerResult | null) : null;

  return (
    <div className="rounded-3xl border border-black/10 bg-white/70 p-5 shadow-md shadow-black/5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-black/50">
            Result
          </p>
          <p className="text-lg font-semibold text-black">
            {analysis ? "Analysis overview" : "Awaiting input"}
          </p>
          {analysis ? (
            <p className="text-xs text-black/50">
              Created {new Date(analysis.created_at).toLocaleString()}
            </p>
          ) : null}
        </div>
        <StatusPill status={analysis?.status ?? "pending"} />
      </div>

      {loading ? (
        <div className="mt-4 rounded-2xl border border-black/5 bg-black/[0.02] px-4 py-6 text-sm text-black/60">
          Running analysis…
        </div>
      ) : null}

      {!analysis && !loading ? (
        <div className="mt-4 rounded-2xl border border-dashed border-black/10 bg-white/60 px-4 py-6 text-sm text-black/60">
          Submit a query to see the analyzer findings, index suggestions, and anti-patterns.
        </div>
      ) : null}

      {analysis && isErrorResult && errorPayload ? (
        <div className="mt-4">
          <ErrorBanner error={errorPayload} />
        </div>
      ) : null}

      {analysis && !isErrorResult && result ? (
        <div className="mt-5 space-y-5">
          <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-black/50">
              Primary bottleneck
            </p>
            <p className="mt-1 text-base font-semibold text-black">
              {result.primary_bottleneck ?? "No dominant bottleneck detected"}
            </p>
          </div>

          <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-black">Findings</p>
              <span className="text-xs text-black/50">
                {(result.findings ?? []).length} items
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {result.findings && result.findings.length > 0 ? (
                result.findings.map((finding) => {
                  const styleKey = finding.severity.toLowerCase();
                  const style = severityStyles[styleKey] ?? "bg-black/5 text-black border-black/10";
                  return (
                    <div
                      key={`${finding.code}-${finding.title}`}
                      className="rounded-xl border border-black/10 bg-white/70 p-3 shadow-sm shadow-black/5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-black">{finding.title}</p>
                          <p className="text-xs text-black/60">{finding.code}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${style}`}>
                          {finding.severity}
                        </span>
                      </div>
                      {finding.impact ? (
                        <p className="mt-2 text-sm text-black/70">Impact: {finding.impact}</p>
                      ) : null}
                      {finding.remediation ? (
                        <p className="mt-1 text-sm text-black/70">
                          Remediation: {finding.remediation}
                        </p>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-black/60">No findings for this plan.</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-black">Suggested indexes</p>
              <span className="text-xs text-black/50">
                {(result.suggested_indexes ?? []).length} ideas
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {result.suggested_indexes && result.suggested_indexes.length > 0 ? (
                result.suggested_indexes.map((index) => (
                  <div
                    key={`${index.table}-${index.columns.join("-")}`}
                    className="rounded-xl border border-black/10 bg-white/70 p-3 shadow-sm shadow-black/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-black">
                          {index.table} ({index.columns.join(", ")})
                        </p>
                        <p className="text-xs text-black/60">{index.reason}</p>
                      </div>
                      <button
                        className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-black transition hover:border-black/30 hover:bg-black/5"
                        onClick={() => navigator.clipboard.writeText(index.sql)}
                        type="button"
                      >
                        Copy SQL
                      </button>
                    </div>
                    <pre className="mt-2 overflow-auto rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-black/80">
                      {index.sql}
                    </pre>
                  </div>
                ))
              ) : (
                <p className="text-sm text-black/60">No index suggestions were generated.</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
            <p className="text-sm font-semibold text-black">Suggested rewrite</p>
            {result.suggested_rewrite ? (
              <div className="mt-2 space-y-2 text-sm text-black/70">
                <p className="font-semibold text-black">{result.suggested_rewrite.title}</p>
                {result.suggested_rewrite.sql ? (
                  <pre className="overflow-auto rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-black/80">
                    {result.suggested_rewrite.sql}
                  </pre>
                ) : null}
                {result.suggested_rewrite.rationale ? (
                  <p className="text-sm text-black/70">{result.suggested_rewrite.rationale}</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm text-black/60">No rewrite suggested for this query.</p>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
              <p className="text-sm font-semibold text-black">Anti-patterns</p>
              <div className="mt-2 space-y-2">
                {result.anti_patterns && result.anti_patterns.length > 0 ? (
                  result.anti_patterns.map((item) => (
                    <div
                      key={item}
                      className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-black/70"
                    >
                      {item}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-black/60">No anti-patterns detected.</p>
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
              <p className="text-sm font-semibold text-black">Confidence</p>
              <p className="mt-2 text-3xl font-semibold text-black">
                {result.confidence?.overall ? Math.round(result.confidence.overall * 100) : 60}%
              </p>
              <p className="text-xs text-black/60">
                Missing data: {(result.confidence?.missing_data ?? []).join(", ") || "none"}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ProjectAnalysesPage() {
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string"
      ? params.projectId
      : Array.isArray(params?.projectId)
        ? params.projectId[0]
        : "";
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<AnalysisResource[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] = useState<AnalysisResource | null>(null);
  const [sql, setSql] = useState(sampleSql);
  const [explainInput, setExplainInput] = useState(sampleExplainJson);
  const [metadataOnly, setMetadataOnly] = useState(true);
  const [focusPerformance, setFocusPerformance] = useState(true);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resultRef = useRef<HTMLDivElement | null>(null);

  const projectOptions = useMemo(() => projects, [projects]);

  const loadProjects = async () => {
    setPageError(null);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" });
      if (response.status === 401) {
        setPageError("Please sign in to view this project.");
        setProjectsLoaded(true);
        return;
      }
      const payload = (await response.json()) as { projects?: Project[] };
      setProjects(payload.projects ?? []);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setProjectsLoaded(true);
    }
  };

  const loadHistory = async (projectId: string) => {
    setLoadingHistory(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/analyses?project_id=${encodeURIComponent(projectId)}`,
        { credentials: "include" }
      );
      const payload = (await response.json().catch(() => null)) as
        | { analyses?: AnalysisResource[] }
        | ApiError
        | null;
      if (!response.ok) {
        const err =
          payload && "code" in (payload as ApiError)
            ? (payload as ApiError)
            : ({ code: "ANALYZER_ERROR", message: "Failed to load history" } as ApiError);
        setSubmitError(err);
        setHistory([]);
        return;
      }
      const analyses = (payload as { analyses?: AnalysisResource[] }).analyses ?? [];
      setHistory(analyses);
      setSelectedAnalysis((prev) => {
        if (prev) {
          const stillExists = analyses.find((item) => item.id === prev.id);
          if (stillExists) {
            return stillExists;
          }
        }
        return analyses[0] ?? null;
      });
    } catch (err) {
      setSubmitError({
        code: "ANALYZER_ERROR",
        message: err instanceof Error ? err.message : "Failed to load history",
      });
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!projectsLoaded) return;
    const nextProject = projects.find((project) => project.id === projectId) ?? null;
    if (nextProject) {
      setCurrentProject(nextProject);
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, nextProject.id);
      loadHistory(nextProject.id);
    } else if (projects.length > 0) {
      setPageError("Project not found or you do not have access.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, projectId, projects]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setLoadingAnalysis(true);
    setIsSubmitting(true);

    if (!currentProject) {
      setSubmitError({ code: "INVALID_INPUT", message: "Select a project first." });
      setIsSubmitting(false);
      setLoadingAnalysis(false);
      return;
    }

    let parsedExplain: unknown;
    try {
      parsedExplain = JSON.parse(explainInput);
    } catch (err) {
      setSubmitError({
        code: "INVALID_EXPLAIN_JSON",
        message: "Explain JSON must be valid JSON",
      });
      setIsSubmitting(false);
      setLoadingAnalysis(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/v1/analyses`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql,
          explain_json: parsedExplain,
          project_id: currentProject.id,
          metadata_only: metadataOnly,
          focus_performance: focusPerformance,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { analysis: AnalysisResource }
        | ApiError
        | null;

      if (!response.ok || !payload || !("analysis" in payload)) {
        const errPayload =
          payload && "code" in (payload as ApiError)
            ? (payload as ApiError)
            : ({
                code: "ANALYZER_ERROR",
                message: "Failed to create analysis",
              } satisfies ApiError);
        setSubmitError(errPayload);
        return;
      }

      setSelectedAnalysis(payload.analysis);
      await loadHistory(currentProject.id);
      if (resultRef.current) {
        resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      setSubmitError({
        code: "ANALYZER_ERROR",
        message: err instanceof Error ? err.message : "Unexpected error",
      });
    } finally {
      setIsSubmitting(false);
      setLoadingAnalysis(false);
    }
  };

  if (pageError) {
    return (
      <div className="min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
        <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-6 py-16">
          <div className="w-full rounded-3xl border border-black/10 bg-white/80 p-8 text-center shadow-lg shadow-black/10">
            <p className="text-lg font-semibold text-black">Access issue</p>
            <p className="mt-2 text-sm text-black/60">{pageError}</p>
            <div className="mt-4 flex justify-center gap-3 text-sm font-semibold">
              <Link className="text-black underline" href="/login">
                Login
              </Link>
              <Link className="text-black underline" href="/projects">
                Back to projects
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-cyan-300/25 blur-3xl" />
        <div className="absolute -bottom-52 left-10 h-[520px] w-[520px] rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-10 sm:px-10">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-black/50">
              Project analysis
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-black sm:text-4xl">
              New analysis + history
            </h1>
            <p className="mt-2 text-sm text-black/60">
              Submit a query with its EXPLAIN JSON, then review bottlenecks, indexes, and confidence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-black outline-none transition hover:border-black/30 focus:border-cyan-600"
              value={currentProject?.id ?? ""}
              onChange={(event) => router.push(`/projects/${event.target.value}/analyses`)}
            >
              <option value="" disabled>
                Select project
              </option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <Link
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-black shadow-sm shadow-black/5 transition hover:border-black/30 hover:bg-black/5"
              href="/projects"
            >
              Projects
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
          <section className="space-y-4">
            <div className="rounded-3xl border border-black/10 bg-white/80 p-5 shadow-md shadow-black/5 backdrop-blur-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-black/50">
                    New analysis
                  </p>
                  <p className="text-lg font-semibold text-black">
                    {currentProject?.name ?? "Select a project"}
                  </p>
                  <p className="text-xs text-black/50">
                    SQL + EXPLAIN JSON stay in this project. Only read-only queries are accepted.
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-black/[0.02] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/60">
                  Auth: session cookie
                </div>
              </div>

              <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold uppercase tracking-[0.2em] text-black/60">
                      SQL (read-only)
                    </label>
                    <span className="text-[11px] text-black/50">Monaco editor</span>
                  </div>
                  <div className="mt-2 overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm shadow-black/5">
                    <MonacoEditor
                      height="240px"
                      language="sql"
                      theme="vs-light"
                      value={sql}
                      options={{
                        fontSize: 14,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                      }}
                      onChange={(value: string | undefined) => setSql(value ?? "")}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-[0.2em] text-black/60">
                    EXPLAIN JSON
                  </label>
                  <textarea
                    className="mt-2 h-48 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 font-mono text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                    value={explainInput}
                    onChange={(event) => setExplainInput(event.target.value)}
                    spellCheck={false}
                  />
                  <p className="mt-1 text-[11px] text-black/50">
                    Paste the JSON output of <code className="font-mono">EXPLAIN (FORMAT JSON)</code>.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold transition ${
                      metadataOnly
                        ? "border-cyan-500/60 bg-cyan-50/70 text-black shadow-sm shadow-cyan-900/10"
                        : "border-black/10 bg-white/70 text-black"
                    }`}
                    onClick={() => setMetadataOnly((prev) => !prev)}
                  >
                    <p className="text-xs uppercase tracking-[0.18em] text-black/50">Flag</p>
                    <p className="text-sm font-semibold text-black">Metadata only</p>
                    <p className="text-xs text-black/60">
                      Treat plan as metadata-only run (skip live stats).
                    </p>
                  </button>
                  <button
                    type="button"
                    className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold transition ${
                      focusPerformance
                        ? "border-emerald-500/60 bg-emerald-50/70 text-black shadow-sm shadow-emerald-900/10"
                        : "border-black/10 bg-white/70 text-black"
                    }`}
                    onClick={() => setFocusPerformance((prev) => !prev)}
                  >
                    <p className="text-xs uppercase tracking-[0.18em] text-black/50">Flag</p>
                    <p className="text-sm font-semibold text-black">Performance focus</p>
                    <p className="text-xs text-black/60">Prioritize bottleneck + index heuristics.</p>
                  </button>
                </div>

                {submitError ? <ErrorBanner error={submitError} /> : null}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    className="rounded-full bg-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white shadow-lg shadow-black/10 transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                    type="submit"
                    disabled={isSubmitting || !currentProject}
                  >
                    {isSubmitting ? "Submitting..." : "Analyze query"}
                  </button>
                  <p className="text-xs text-black/50">
                    Errors: PLAN_LIMIT_EXCEEDED, RATE_LIMITED, SQL_NOT_READ_ONLY, INVALID_EXPLAIN_JSON, ANALYZER_TIMEOUT
                  </p>
                </div>
              </form>
            </div>

            <div className="rounded-3xl border border-black/10 bg-white/70 p-5 shadow-sm shadow-black/5">
              <p className="text-sm font-semibold text-black">Example helper</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-black/10 bg-black/[0.03] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/50">
                    Sample SQL
                  </p>
                  <pre className="mt-2 overflow-auto text-sm text-black/80">{sampleSql}</pre>
                </div>
                <div className="rounded-2xl border border-black/10 bg-black/[0.03] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/50">
                    Sample EXPLAIN JSON
                  </p>
                  <pre className="mt-2 max-h-48 overflow-auto text-xs text-black/80">
                    {sampleExplainJson}
                  </pre>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4" ref={resultRef}>
            <ResultView analysis={selectedAnalysis} loading={loadingAnalysis} />
            <HistoryList
              analyses={history}
              selectedId={selectedAnalysis?.id ?? null}
              onSelect={(id) => {
                const found = history.find((item) => item.id === id);
                setSelectedAnalysis(found ?? selectedAnalysis);
              }}
              loading={loadingHistory}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
