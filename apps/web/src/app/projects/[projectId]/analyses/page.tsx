"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
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
const SIDEBAR_STATE_KEY = "sqlcortex.sidebarOpen";

type ApiError = { code: string; message: string; details?: Record<string, unknown> };

type Membership = {
  org_id: string;
  org_name: string;
  role: string;
};

type Project = {
  id: string;
  name: string;
  org_id: string | null;
  owner_user_id: string | null;
};

type MeResponse = {
  user: { id: string; email: string; name: string | null } | null;
  org: { id: string; name: string } | null;
  memberships: Membership[];
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
  plain_summary?: string[];
  findings?: Finding[];
  suggested_indexes?: IndexSuggestion[];
  suggested_rewrite?:
    | {
        title: string;
        sql?: string | null;
        rationale?: string | null;
        notes?: string[];
        confidence?: number | null;
      }
    | null;
  suggested_rewrite_explanation?: string | null;
  anti_patterns?: string[];
  confidence?: { overall: number; missing_data: string[] };
  llm_used?: boolean;
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
        {loading ? <span className="text-xs text-black/50">Refreshing...</span> : null}
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
                      {analysis.sql.length > 48 ? `${analysis.sql.slice(0, 48)}...` : analysis.sql}
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
          Running analysis...
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

          {result.plain_summary && result.plain_summary.length > 0 ? (
            <div className="rounded-2xl border border-black/10 bg-white/80 p-4 shadow-sm shadow-black/5">
              <p className="text-sm font-semibold text-black">Plain-English summary</p>
              <div className="mt-2 space-y-2 text-sm text-black/70">
                {result.plain_summary.map((item, index) => (
                  <p key={`${item}-${index}`}>{item}</p>
                ))}
              </div>
            </div>
          ) : null}

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
                {result.suggested_rewrite.notes && result.suggested_rewrite.notes.length > 0 ? (
                  <div className="space-y-1 text-xs text-black/60">
                    {result.suggested_rewrite.notes.map((note, index) => (
                      <p key={`${note}-${index}`}>- {note}</p>
                    ))}
                  </div>
                ) : null}
                {typeof result.suggested_rewrite.confidence === "number" ? (
                  <p className="text-xs text-black/60">
                    Rewrite confidence: {Math.round(result.suggested_rewrite.confidence * 100)}%
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm text-black/60">
                {result.suggested_rewrite_explanation ??
                  "No rewrite suggested for this query."}
              </p>
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
  const [me, setMe] = useState<MeResponse | null>(null);
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
  const [profileOpen, setProfileOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);

  const resultRef = useRef<HTMLDivElement | null>(null);

  const projectOptions = useMemo(() => projects, [projects]);

  const loadProjects = async () => {
    setPageError(null);
    try {
      const [meResponse, projectsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
      ]);
      if (meResponse.status === 401 || projectsResponse.status === 401) {
        setPageError("Please sign in to view this project.");
        setProjectsLoaded(true);
        return;
      }
      if (!meResponse.ok || !projectsResponse.ok) {
        throw new Error("Failed to load workspace context");
      }
      const mePayload = (await meResponse.json()) as MeResponse;
      const projectsPayload = (await projectsResponse.json()) as { projects?: Project[] };
      setMe(mePayload);
      setProjects(projectsPayload.projects ?? []);
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
    const handleClick = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_STATE_KEY);
    if (stored !== null) {
      setIsSidebarOpen(stored === "true");
    }
    setSidebarReady(true);
  }, []);

  useEffect(() => {
    if (!sidebarReady) return;
    window.localStorage.setItem(SIDEBAR_STATE_KEY, String(isSidebarOpen));
  }, [isSidebarOpen, sidebarReady]);

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

  const handleLogout = async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  };

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

  const primaryProject = currentProject ?? projects[0] ?? null;
  const displayProject = currentProject ?? primaryProject;
  const userEmail = me?.user?.email ?? "Unknown";
  const userName = me?.user?.name ?? userEmail;
  const userInitial = userEmail.slice(0, 1).toUpperCase();
  const primaryRole = (me?.memberships?.[0]?.role ?? "member").toUpperCase();

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-cyan-300/25 blur-3xl" />
        <div className="absolute -bottom-52 left-10 h-[520px] w-[520px] rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative flex min-h-screen flex-col md:flex-row">
        <aside
          aria-hidden={!isSidebarOpen}
          className={`relative z-20 flex flex-col border-b border-white/10 bg-gradient-to-b from-[#0b1120] via-[#0c162e] to-[#0a0f1f] text-white/80 transition-[width,opacity] duration-300 md:sticky md:top-0 md:h-screen md:border-b-0 md:border-white/10 ${
            isSidebarOpen
              ? "w-full md:w-64 md:border-r md:shadow-2xl md:shadow-black/30"
              : "hidden md:flex md:w-20 md:border-r md:shadow-2xl md:shadow-black/20"
          }`}
          id="primary-navigation"
        >
          <div className={`pt-6 ${isSidebarOpen ? "px-6" : "px-3"}`}>
            <div className={`flex flex-col items-center text-center ${isSidebarOpen ? "gap-3" : "gap-2"}`}>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 shadow-sm shadow-black/40">
                <Image
                  src="/SQLCortexLogo.png"
                  alt="SQLCortex"
                  width={30}
                  height={30}
                  className="h-7 w-auto"
                />
              </div>
              <div className={isSidebarOpen ? "" : "hidden"}>
                <p className="text-sm font-semibold tracking-tight text-white">SQLCortex</p>
                <p className="text-[10px] uppercase tracking-[0.3em] text-white/40">Control deck</p>
              </div>
            </div>
          </div>

          <div className={`mt-8 ${isSidebarOpen ? "px-4" : "px-2"}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.3em] text-white/40 ${
                isSidebarOpen ? "" : "hidden"
              }`}
            >
              Menu
            </p>
            <nav className={`mt-3 ${isSidebarOpen ? "space-y-1.5" : "space-y-2"}`}>
              <Link
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/dashboard"
                title="Dashboard"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 11l9-7 9 7" />
                    <path d="M9 22V12h6v10" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>Dashboard</span>
              </Link>
              <Link
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/projects"
                title="Projects"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>Projects</span>
              </Link>
              {primaryProject ? (
                <Link
                  aria-current="page"
                  className={`relative flex items-center rounded-xl border border-white/10 bg-white/10 py-2 text-sm font-semibold text-white shadow-sm shadow-black/30 ${
                    isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                  }`}
                  href={`/projects/${primaryProject.id}/analyses`}
                  title="Analyses"
                >
                  <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-sky-300" />
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 16l4-5 4 3 6-7" />
                      <path d="M20 7v6h-6" />
                    </svg>
                  </span>
                  <span className={isSidebarOpen ? "" : "hidden"}>Analyses</span>
                </Link>
              ) : (
                <div
                  className={`flex items-center rounded-xl border border-dashed border-white/10 py-2 text-sm font-semibold text-white/30 ${
                    isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                  }`}
                  title="Analyses"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 16l4-5 4 3 6-7" />
                      <path d="M20 7v6h-6" />
                    </svg>
                  </span>
                  <span className={isSidebarOpen ? "" : "hidden"}>Analyses</span>
                </div>
              )}
              <Link
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/organizations"
                title="Organizations"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 11h10M5 19h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2z" />
                    <path d="M7 7h10" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>Organizations</span>
              </Link>
              <Link
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/tokens"
                title="API tokens"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 7v10M7 12h10" />
                    <rect x="4" y="4" width="16" height="16" rx="4" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>API tokens</span>
              </Link>
              <Link
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/invitations"
                title="Invitations"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 7h16M4 12h16M4 17h10" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>Invitations</span>
              </Link>
            </nav>
          </div>

          <div className={`mt-8 ${isSidebarOpen ? "px-4" : "hidden"}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-white/40">Projects</p>
            <div className="mt-3 space-y-2">
              {displayProject ? (
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    <span className="text-sm font-semibold text-white">{displayProject.name}</span>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">Active</span>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-xs text-white/40">
                  No project yet
                </div>
              )}
            </div>
          </div>

          <div className={`mt-auto ${isSidebarOpen ? "px-4 pb-6" : "px-2 pb-4"}`}>
            {isSidebarOpen ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-white/70 shadow-sm shadow-black/30">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                  Signed in
                </p>
                <p className="mt-1 text-sm text-white">{userEmail}</p>
                <button
                  className="mt-3 w-full rounded-full border border-white/10 bg-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white transition hover:bg-white/20"
                  onClick={handleLogout}
                >
                  Logout
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-xs text-white/70 shadow-sm shadow-black/30">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-white">
                  {userInitial}
                </span>
              </div>
            )}
          </div>
        </aside>

        <div className="flex-1">
          <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 shadow-sm shadow-black/5 backdrop-blur-sm">
            <div className="flex w-full flex-wrap items-center justify-between gap-4 px-6 py-4">
              <div className="flex items-center gap-3">
                <button
                  aria-controls="primary-navigation"
                  aria-expanded={isSidebarOpen}
                  aria-label="Toggle navigation"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white text-black/60"
                  onClick={() => setIsSidebarOpen((prev) => !prev)}
                  type="button"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 7h16M4 12h16M4 17h16" />
                  </svg>
                </button>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-black/40">Projects</p>
                  <div className="flex items-center gap-2 text-sm font-semibold text-black/80">
                    <span>Analyses</span>
                    <span className="text-black/30">/</span>
                    <span>{currentProject?.name ?? "Select project"}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
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
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black shadow-sm shadow-black/5 transition hover:border-black/30 hover:bg-black/5"
                  href="/projects"
                >
                  Projects
                </Link>
                <button className="flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-white text-black/50">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3v2" />
                    <path d="M12 19v2" />
                    <path d="M5.6 5.6l1.4 1.4" />
                    <path d="M17 17l1.4 1.4" />
                    <path d="M3 12h2" />
                    <path d="M19 12h2" />
                    <path d="M5.6 18.4l1.4-1.4" />
                    <path d="M17 7l1.4-1.4" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                </button>
                <button className="flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-white text-black/50">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
                    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                  </svg>
                </button>

                <div className="relative" ref={profileMenuRef}>
                  <button
                    className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-2 py-1.5 text-xs font-semibold text-black/70"
                    onClick={() => setProfileOpen((prev) => !prev)}
                    type="button"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                      {userInitial}
                    </span>
                    <span className="hidden text-sm font-semibold text-black/80 sm:inline">
                      {userEmail}
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4 text-black/50"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>

                  {profileOpen ? (
                    <div className="absolute right-0 top-12 w-56 rounded-2xl border border-black/10 bg-white p-2 text-sm text-black/70 shadow-xl shadow-black/10">
                      <div className="rounded-xl border border-black/10 bg-black/5 px-3 py-2">
                        <p className="text-sm font-semibold text-black">{userName}</p>
                        <p className="text-xs text-black/50">{userEmail}</p>
                        <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-black/40">
                          Role {primaryRole}
                        </p>
                      </div>
                      <div className="mt-2 space-y-1 border-t border-black/10 pt-2">
                        <button
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-black/70 hover:bg-black/5"
                          onClick={() => setProfileOpen(false)}
                          type="button"
                        >
                          Profile
                        </button>
                        <button
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-black/70 hover:bg-black/5"
                          onClick={() => setProfileOpen(false)}
                          type="button"
                        >
                          Settings
                        </button>
                      </div>
                      <div className="mt-2 border-t border-black/10 pt-2">
                        <button
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-500 hover:bg-rose-50"
                          onClick={handleLogout}
                          type="button"
                        >
                          Sign out
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </header>

          <div className="w-full px-6 pb-12 pt-8">
        {!projectsLoaded ? (
          <div className="mb-6 rounded-xl border border-black/10 bg-white/70 px-4 py-2 text-xs text-black/60">
            Loading workspace...
          </div>
        ) : null}
        <div className="mb-8">
          <p className="text-xs font-medium uppercase tracking-wider text-black/40">Project analysis</p>
          <h1 className="mt-1 text-2xl font-semibold text-black/90">New analysis + history</h1>
          <p className="mt-1 text-sm text-black/60">
            Submit a query with its EXPLAIN JSON, then review bottlenecks, indexes, and confidence.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
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
    </div>
    </div>
  );
}
