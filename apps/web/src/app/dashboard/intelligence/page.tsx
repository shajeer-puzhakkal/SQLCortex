"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  IntelligenceHistoryEvent,
  IntelligenceHistoryResponse,
  IntelligenceTopRiskyResponse,
  IntelligenceTrendsResponse,
} from "@/types/contracts";

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

function riskColor(level: string): string {
  if (level === "Dangerous") return "text-rose-700 bg-rose-100 border-rose-200";
  if (level === "Warning") return "text-amber-700 bg-amber-100 border-amber-200";
  return "text-emerald-700 bg-emerald-100 border-emerald-200";
}

export default function IntelligenceCenterPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [range, setRange] = useState<"7d" | "30d">("7d");
  const [history, setHistory] = useState<IntelligenceHistoryResponse | null>(null);
  const [topRisky, setTopRisky] = useState<IntelligenceTopRiskyResponse | null>(null);
  const [trends, setTrends] = useState<IntelligenceTrendsResponse | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<IntelligenceHistoryEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const points = trends?.points ?? [];
  const maxEvents = Math.max(...points.map((point) => point.events), 1);
  const maxHeat = Math.max(...(trends?.heatmap.map((cell) => cell.events) ?? [0]), 1);
  const heatmapLookup = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of trends?.heatmap ?? []) {
      map.set(`${cell.day_of_week}:${cell.hour_of_day}`, cell.events);
    }
    return map;
  }, [trends]);

  useEffect(() => {
    const loadBoot = async () => {
      setError(null);
      try {
        const [meResponse, projectsResponse] = await Promise.all([
          fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
          fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
        ]);
        if (meResponse.status === 401) {
          router.push("/login");
          return;
        }
        const _me = (await meResponse.json()) as MeResponse;
        if (!_me.user) {
          router.push("/login");
          return;
        }
        const payload = (await projectsResponse.json()) as { projects: Project[] };
        const nextProjects = payload.projects ?? [];
        setProjects(nextProjects);

        const stored = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
        const initialProjectId = stored ?? nextProjects[0]?.id ?? null;
        setActiveProjectId(initialProjectId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load intelligence center");
      }
    };
    void loadBoot();
  }, [router]);

  useEffect(() => {
    if (!activeProjectId) {
      setLoading(false);
      return;
    }
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
    const loadData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [historyResponse, topRiskyResponse, trendsResponse] = await Promise.all([
          fetch(
            `${API_BASE}/api/intelligence/history?project_id=${encodeURIComponent(activeProjectId)}&page=1&limit=20`,
            { credentials: "include" },
          ),
          fetch(
            `${API_BASE}/api/intelligence/top-risky?project_id=${encodeURIComponent(activeProjectId)}&range=${range}&limit=8`,
            { credentials: "include" },
          ),
          fetch(
            `${API_BASE}/api/intelligence/trends?project_id=${encodeURIComponent(activeProjectId)}&range=${range}`,
            { credentials: "include" },
          ),
        ]);

        if (!historyResponse.ok || !topRiskyResponse.ok || !trendsResponse.ok) {
          throw new Error("Failed to load intelligence data.");
        }

        const nextHistory = (await historyResponse.json()) as IntelligenceHistoryResponse;
        const nextTopRisky = (await topRiskyResponse.json()) as IntelligenceTopRiskyResponse;
        const nextTrends = (await trendsResponse.json()) as IntelligenceTrendsResponse;
        setHistory(nextHistory);
        setTopRisky(nextTopRisky);
        setTrends(nextTrends);
        setSelectedEvent(nextHistory.events[0] ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load intelligence data.");
      } finally {
        setLoading(false);
      }
    };
    void loadData();
  }, [activeProjectId, range]);

  return (
    <div className="min-h-screen bg-[#f8f4ee] px-6 py-8 text-[#1b1b1b]">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-black/40">Dashboard</p>
            <h1 className="text-2xl font-semibold text-black/90">Intelligence Center</h1>
            <p className="text-sm text-black/60">Query score trends, risk hotspots, and recent query events.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black/70 hover:border-black/30"
            >
              Back to Dashboard
            </Link>
            <select
              value={activeProjectId ?? ""}
              onChange={(event) => setActiveProjectId(event.target.value || null)}
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-black"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          {(["7d", "30d"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setRange(value)}
              className={`rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] ${
                range === value
                  ? "border-cyan-600 bg-cyan-50 text-cyan-800"
                  : "border-black/10 bg-white text-black/60"
              }`}
            >
              {value}
            </button>
          ))}
          {activeProject ? <span className="ml-2 text-sm text-black/50">{activeProject.name}</span> : null}
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-2xl border border-black/10 bg-white/70 px-4 py-6 text-sm text-black/60">
            Loading intelligence telemetry...
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <section className="space-y-6">
            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Score Trend</h2>
              <div className="mt-4 flex items-end gap-2">
                {points.map((point) => (
                  <div key={point.date} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex h-28 w-full items-end justify-center">
                      <div
                        className="w-3 rounded-full bg-cyan-300/80"
                        style={{ height: `${(point.events / maxEvents) * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] uppercase tracking-[0.18em] text-black/40">{point.date.slice(5)}</span>
                    <span className="text-[10px] text-black/50">{point.avg_score ?? "-"}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Recent Events</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-black/40">
                      <th className="pb-2 pr-3">Time</th>
                      <th className="pb-2 pr-3">Fingerprint</th>
                      <th className="pb-2 pr-3">Score</th>
                      <th className="pb-2 pr-3">Risk</th>
                      <th className="pb-2 pr-3">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(history?.events ?? []).map((event) => (
                      <tr
                        key={event.id}
                        onClick={() => setSelectedEvent(event)}
                        className="cursor-pointer border-t border-black/5 hover:bg-black/[0.02]"
                      >
                        <td className="py-2 pr-3 text-black/60">{new Date(event.created_at).toLocaleString()}</td>
                        <td className="py-2 pr-3 font-mono text-[12px] text-black/80">{event.query_fingerprint.slice(0, 18)}...</td>
                        <td className="py-2 pr-3 font-semibold text-black/80">{event.score}</td>
                        <td className="py-2 pr-3">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${riskColor(event.risk_level)}`}>
                            {event.risk_level}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-black/70">{event.cost_bucket}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Risk Distribution</h2>
              <div className="mt-3 space-y-2">
                {(trends?.risk_distribution ?? []).map((row) => (
                  <div key={row.risk_level} className="flex items-center justify-between text-sm">
                    <span className="text-black/70">{row.risk_level}</span>
                    <span className="font-semibold text-black/90">{row.count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Top Risky Queries</h2>
              <div className="mt-3 space-y-2">
                {(topRisky?.items ?? []).map((item) => (
                  <div key={item.query_fingerprint} className="rounded-xl border border-black/10 bg-white/80 p-3">
                    <p className="font-mono text-xs text-black/70">{item.query_fingerprint.slice(0, 22)}...</p>
                    <p className="mt-1 text-sm font-semibold text-black/85">
                      {item.risk_level} • min {item.min_score}
                    </p>
                    <p className="text-xs text-black/55">{item.events_count} events</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Heatmap</h2>
              <div className="mt-3 space-y-1">
                {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                  <div key={day} className="flex gap-1">
                    {Array.from({ length: 24 }).map((_, hour) => {
                      const value = heatmapLookup.get(`${day}:${hour}`) ?? 0;
                      const opacity = value === 0 ? 0.1 : Math.max(0.18, value / maxHeat);
                      return <div key={`${day}-${hour}`} className="h-2 w-2 rounded-sm bg-cyan-500" style={{ opacity }} />;
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
              <h2 className="text-lg font-semibold">Drilldown</h2>
              {selectedEvent ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-black/60">{selectedEvent.query_fingerprint}</p>
                  <pre className="max-h-56 overflow-auto rounded-xl bg-black/[0.03] p-3 text-[11px] text-black/75">
                    {JSON.stringify(selectedEvent.reasons_json, null, 2)}
                  </pre>
                </div>
              ) : (
                <p className="mt-3 text-sm text-black/60">Select an event to inspect reasons and recommendations.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
