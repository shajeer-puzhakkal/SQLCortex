"use client";

import { useEffect, useMemo, useState } from "react";
import type { DashboardUsageResponse } from "@/types/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const ACTIVE_PROJECT_KEY = "sqlcortex.activeProjectId";

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

type OrgOption = {
  id: string;
  name: string;
};

type RangeValue = "7d" | "30d";

const actionLabelMap: Record<string, string> = {
  query_analysis: "Query analysis",
  query_execute: "Query execute",
  ai_explain: "AI explain",
  ai_suggest: "AI suggest",
  reanalyze: "Reanalyze",
};

function formatActionLabel(action: string) {
  return actionLabelMap[action] ?? action.replace(/_/g, " ");
}

export default function DashboardUsagePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [usage, setUsage] = useState<DashboardUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(false);
  const [selectionReady, setSelectionReady] = useState(false);

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeValue>("7d");

  const orgOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const membership of me?.memberships ?? []) {
      map.set(membership.org_id, membership.org_name);
    }
    if (me?.org) {
      map.set(me.org.id, me.org.name);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [me]);

  const showPersonalOption = Boolean(me?.user);

  const scopedProjects = useMemo(() => {
    return projects.filter((project) => project.org_id === selectedOrgId);
  }, [projects, selectedOrgId]);

  useEffect(() => {
    const loadContext = async () => {
      setContextLoading(true);
      setError(null);
      try {
        const [meResponse, projectsResponse] = await Promise.all([
          fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
          fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
        ]);

        if (meResponse.status === 401) {
          setError("Please sign in to view usage.");
          setContextLoading(false);
          return;
        }

        if (!meResponse.ok) {
          throw new Error("Failed to load account details");
        }

        const mePayload = (await meResponse.json()) as MeResponse;
        const projectsPayload = (await projectsResponse.json()) as { projects: Project[] };
        setMe(mePayload);
        setProjects(projectsPayload.projects ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setContextLoading(false);
      }
    };

    void loadContext();
  }, []);

  useEffect(() => {
    if (contextLoading || selectionReady || !me) return;

    const defaultOrgId = me.org?.id ?? me.memberships?.[0]?.org_id ?? null;
    setSelectedOrgId(defaultOrgId);
    setSelectedProjectId(null);
    setSelectionReady(true);
  }, [contextLoading, selectionReady, me]);

  useEffect(() => {
    if (!selectionReady || !me) return;

    const loadUsage = async () => {
      setUsageLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ range });
        if (selectedOrgId) {
          params.set("org_id", selectedOrgId);
        }
        if (selectedProjectId) {
          params.set("project_id", selectedProjectId);
        }
        const response = await fetch(`${API_BASE}/dashboard/usage?${params.toString()}`, {
          credentials: "include",
        });

        if (response.status === 401) {
          setError("Please sign in to view usage.");
          setUsage(null);
          return;
        }

        if (!response.ok) {
          throw new Error("Failed to load usage");
        }

        const payload = (await response.json()) as DashboardUsageResponse;
        setUsage(payload);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load usage");
        setUsage(null);
      } finally {
        setUsageLoading(false);
      }
    };

    void loadUsage();
  }, [range, selectedOrgId, selectedProjectId, selectionReady, me]);

  useEffect(() => {
    if (selectedProjectId) {
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, selectedProjectId);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    }
  }, [selectedProjectId]);

  const totalActions = usage?.totalActions ?? 0;
  const aiActions = usage?.aiActions ?? 0;
  const ruleActions = usage?.ruleActions ?? 0;
  const actionBreakdown = usage?.byAction ?? [];
  const timeline = usage?.timeline ?? [];
  const maxCount = Math.max(...timeline.map((entry) => entry.total), 1);
  const hasUsage = totalActions > 0;
  const showEmptyState = !usageLoading && usage !== null && !hasUsage;
  const aiShare = totalActions > 0 ? Math.round((aiActions / totalActions) * 100) : 0;
  const rulesShare = totalActions > 0 ? Math.max(0, 100 - aiShare) : 0;
  const labelInterval = range === "30d" ? 5 : 1;
  const labelFormatter = useMemo(() => {
    return new Intl.DateTimeFormat(
      "en-US",
      range === "7d" ? { weekday: "short" } : { month: "short", day: "numeric" }
    );
  }, [range]);

  const handleOrgChange = (value: string) => {
    const nextOrgId = value === "personal" ? null : value || null;
    setSelectedOrgId(nextOrgId);
    setSelectedProjectId(null);
  };

  const handleProjectChange = (value: string) => {
    const nextProjectId = value === "all" ? null : value;
    setSelectedProjectId(nextProjectId);
  };

  if (error && !me) {
    return (
      <div className="min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
        <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-6 py-16">
          <div className="max-w-md rounded-3xl border border-black/10 bg-white/80 p-8 text-center">
            <p className="text-black/70">{error}</p>
            <a className="mt-6 inline-block text-black underline" href="/login">
              Go to login
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute top-40 left-10 h-[400px] w-[400px] rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 pb-14 pt-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-black/40">Dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold text-black/90">Usage</h1>
            <p className="mt-2 text-sm text-black/60">
              SQLCortex assisted you{" "}
              <span className="font-semibold text-black/80">{totalActions}</span> times.
            </p>
            <p className="mt-1 text-xs text-black/50">View in VS Code for deeper analysis.</p>
          </div>
          <div className="flex flex-col gap-3">
            {usageLoading || contextLoading ? (
              <div className="rounded-full border border-black/10 bg-white/70 px-4 py-2 text-xs text-black/60">
                Updating usage...
              </div>
            ) : null}
            {error ? (
              <div className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-black/10 bg-white/70 p-4 shadow-sm shadow-black/5 backdrop-blur-sm">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-black/40">
              Organization
              <select
                className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-medium text-black/70"
                onChange={(event) => handleOrgChange(event.target.value)}
                value={
                  selectedOrgId ??
                  (showPersonalOption ? "personal" : orgOptions[0]?.id ?? "")
                }
              >
                {showPersonalOption ? <option value="personal">Personal</option> : null}
                {orgOptions.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
                {!showPersonalOption && orgOptions.length === 0 ? (
                  <option value="">No organizations</option>
                ) : null}
              </select>
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-black/40">
              Project
              <select
                className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-medium text-black/70"
                onChange={(event) => handleProjectChange(event.target.value)}
                value={selectedProjectId ?? "all"}
              >
                <option value="all">All projects</option>
                {scopedProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-black/40">
              Time range
              <select
                className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-medium text-black/70"
                onChange={(event) => setRange(event.target.value as RangeValue)}
                value={range}
              >
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-black/50">
            Hint: View in VS Code for query-level detail.
          </p>
        </div>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 shadow-sm shadow-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
              Total assistance actions
            </p>
            <p className="mt-2 text-3xl font-semibold text-black/90">{totalActions}</p>
            <p className="text-xs text-black/50">Usage across the selected scope.</p>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 shadow-sm shadow-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
              AI vs Rules
            </p>
            <div className="mt-3 flex items-center justify-between text-sm text-black/70">
              <span>AI</span>
              <span className="font-semibold text-black/80">{aiActions}</span>
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-black/10">
              <div
                className="h-2 rounded-full bg-emerald-300"
                style={{ width: `${aiShare}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-black/50">
              <span>{aiShare}% AI</span>
              <span>
                {ruleActions} rules ({rulesShare}%)
              </span>
            </div>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/70 p-4 shadow-sm shadow-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
              Action mix
            </p>
            <div className="mt-3 space-y-2 text-sm text-black/70">
              {actionBreakdown.length === 0 ? (
                <p className="text-xs text-black/50">No actions yet.</p>
              ) : (
                actionBreakdown.map((entry) => (
                  <div key={entry.action} className="flex items-center justify-between">
                    <span>{formatActionLabel(entry.action)}</span>
                    <span className="font-semibold text-black/80">{entry.count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Usage timeline</h2>
              <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-700">
                {range === "7d" ? "Last 7 days" : "Last 30 days"}
              </span>
            </div>
            <p className="mt-2 text-sm text-black/60">
              Daily assistance actions across the selected scope.
            </p>
            {showEmptyState ? (
              <div className="mt-6 rounded-xl border border-dashed border-black/15 bg-white/70 px-4 py-6 text-sm text-black/60">
                No activity yet - analyze a query in VS Code to see usage here.
              </div>
            ) : (
              <div className="mt-6 flex items-end gap-2">
                {timeline.map((entry, index) => (
                  <div key={entry.date} className="flex flex-1 flex-col items-center gap-2">
                    <div className="flex h-28 w-full items-end justify-center">
                      <div
                        className="w-3 rounded-full bg-cyan-300/70"
                        style={{ height: `${(entry.total / maxCount) * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                      {index % labelInterval === 0
                        ? labelFormatter.format(new Date(entry.date))
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex items-center justify-between text-xs text-black/50">
              <span>{totalActions} total actions</span>
              <span>{hasUsage ? "Live data" : "No activity yet"}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
            <h2 className="text-lg font-semibold">Value summary</h2>
            <p className="mt-2 text-sm text-black/60">
              SQLCortex assists every query, highlight, and re-check.
            </p>
            <div className="mt-6 space-y-4">
              <div className="rounded-xl border border-black/5 bg-white px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-black/40">
                  Assist total
                </p>
                <p className="mt-2 text-2xl font-semibold text-black/90">{totalActions}</p>
                <p className="text-xs text-black/50">SQLCortex assisted you {totalActions} times.</p>
              </div>
              <div className="rounded-xl border border-black/5 bg-white px-4 py-3 text-xs text-black/60">
                View in VS Code to see the full analysis context.
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
