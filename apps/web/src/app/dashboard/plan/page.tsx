"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import type { BillingCreditsResponse, PlanUsageSummary } from "@/types/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const SIDEBAR_STATE_KEY = "sqlcortex.sidebarOpen";
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

type UpgradeStatus = "idle" | "sending" | "sent" | "error";

export default function PlanPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = searchParams.get("org_id");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [plan, setPlan] = useState<PlanUsageSummary | null>(null);
  const [credits, setCredits] = useState<BillingCreditsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [resolvedOrgId, setResolvedOrgId] = useState<string | null>(null);
  const [upgradeMessage, setUpgradeMessage] = useState("");
  const [upgradeStatus, setUpgradeStatus] = useState<UpgradeStatus>("idle");
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );
  const primaryProject = activeProject ?? projects[0] ?? null;
  const activeOrg = useMemo(() => {
    if (!resolvedOrgId || !me?.memberships) return null;
    return me.memberships.find((entry) => entry.org_id === resolvedOrgId) ?? null;
  }, [me, resolvedOrgId]);

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (stored) {
      setActiveProjectId(stored);
    }
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
    if (activeProjectId) {
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    }
  }, [activeProjectId]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [meResponse, projectsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
      ]);

      if (meResponse.status === 401) {
        setError("Please sign in to view plan details.");
        setLoading(false);
        return;
      }

      const mePayload = (await meResponse.json()) as MeResponse;
      setMe(mePayload);
      const allowedOrgId =
        orgId && mePayload.memberships.some((entry) => entry.org_id === orgId) ? orgId : null;
      setResolvedOrgId(allowedOrgId);
      if (projectsResponse.ok) {
        const projectsPayload = (await projectsResponse.json()) as { projects: Project[] };
        setProjects(projectsPayload.projects ?? []);
      } else {
        setProjects([]);
      }

      const planUrl = allowedOrgId
        ? `${API_BASE}/api/v1/plan?org_id=${encodeURIComponent(allowedOrgId)}`
        : `${API_BASE}/api/v1/plan`;
      const planResponse = await fetch(planUrl, { credentials: "include" });
      if (!planResponse.ok) {
        const payload = await planResponse.json().catch(() => null);
        setError(payload?.message ?? "Failed to load plan details");
        setPlan(null);
        setCredits(null);
        setLoading(false);
        return;
      }

      const planPayload = (await planResponse.json()) as PlanUsageSummary;
      setPlan(planPayload);

      const creditsUrl = allowedOrgId
        ? `${API_BASE}/billing/credits?org_id=${encodeURIComponent(allowedOrgId)}`
        : `${API_BASE}/billing/credits`;
      const creditsResponse = await fetch(creditsUrl, { credentials: "include" });
      if (creditsResponse.ok) {
        const creditsPayload = (await creditsResponse.json()) as BillingCreditsResponse;
        setCredits(creditsPayload);
      } else {
        setCredits(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plan details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [orgId]);

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

  const handleLogout = async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  };

  const handleUpgradeRequest = async () => {
    setUpgradeError(null);
    setUpgradeStatus("sending");
    try {
      const response = await fetch(`${API_BASE}/api/v1/upgrade-request`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: upgradeMessage.trim() || null,
          org_id: resolvedOrgId,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setUpgradeError(payload?.message ?? "Failed to submit upgrade request.");
        setUpgradeStatus("error");
        return;
      }
      setUpgradeStatus("sent");
      setUpgradeMessage("");
    } catch (err) {
      setUpgradeError(err instanceof Error ? err.message : "Failed to submit upgrade request.");
      setUpgradeStatus("error");
    }
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

  const userEmail = me?.user?.email ?? "Unknown";
  const userName = me?.user?.name ?? userEmail;
  const userInitial = userEmail.slice(0, 1).toUpperCase();
  const primaryRole = (me?.memberships?.[0]?.role ?? "member").toUpperCase();
  const hasOrgs = (me?.memberships?.length ?? 0) > 0;
  const needsPlanSelection = !plan && !loading && hasOrgs;
  const hasPlan = Boolean(plan);
  const fallbackPlanLabel = needsPlanSelection
    ? "Select a workspace to view plan details"
    : "Plan details unavailable";
  const planName = plan?.planName ?? fallbackPlanLabel;
  const planId = plan?.planId ?? "-";
  const isFreePlan = planId === "free" || planName.toLowerCase() === "free";
  const aiEnabled = plan?.aiEnabled ?? isFreePlan;
  const limit = plan?.monthlyAiActionsLimit ?? null;
  const used = plan?.usedAiActionsThisPeriod ?? 0;
  const creditSystemEnabled = plan?.creditSystemEnabled ?? isFreePlan;
  const dailyCredits = credits?.dailyCredits ?? plan?.dailyCredits ?? null;
  const creditsRemaining = credits?.creditsRemaining ?? plan?.creditsRemaining ?? null;
  const graceUsed = credits?.graceUsed ?? plan?.graceUsed ?? null;
  const softLimit70Reached =
    credits?.softLimit70Reached ?? plan?.softLimit70Reached ?? false;
  const softLimit90Reached =
    credits?.softLimit90Reached ?? plan?.softLimit90Reached ?? false;
  const planPeriodStart = plan?.periodStart ? new Date(plan.periodStart) : null;
  const planPeriodEnd = plan?.periodEnd ? new Date(plan.periodEnd) : null;
  const usageLimitLabel = hasPlan
    ? creditSystemEnabled && dailyCredits !== null && creditsRemaining !== null
      ? `${creditsRemaining} / ${dailyCredits} credits`
      : creditSystemEnabled
        ? "Daily credits unavailable"
      : limit === null
        ? aiEnabled
          ? `${used} / Unlimited`
          : "Not included"
        : `${used} / ${limit}`
    : needsPlanSelection
      ? "Select a workspace"
      : "Unavailable";
  const aiStatusLabel = hasPlan ? (aiEnabled ? "Enabled" : "Disabled") : "Select a workspace";
  const aiStatusClass = hasPlan
    ? aiEnabled
      ? "text-emerald-600"
      : "text-rose-500"
    : "text-black/40";
  const upgradeAvailable = plan?.upgradeAvailable ?? false;
  const upgradeStatusLabel = hasPlan
    ? upgradeAvailable
      ? "Upgrade available"
      : "Top tier"
    : "Select a workspace";
  const isLimitReached = limit !== null && used >= limit;
  const creditExhausted =
    creditSystemEnabled &&
    creditsRemaining !== null &&
    creditsRemaining <= 0 &&
    graceUsed === true;
  const isGated = hasPlan ? !aiEnabled || isLimitReached || creditExhausted : false;
  const creditNotice =
    credits?.notice ??
    (creditSystemEnabled
      ? softLimit90Reached
        ? "You have used 90% of your daily AI credits. Upgrade to Pro for unlimited usage."
        : softLimit70Reached
          ? "You have used 70% of your daily AI credits. Consider upgrading to Pro."
          : null
      : null);
  const selectionLink = (
    <Link
      className="text-xs font-semibold text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-800"
      href="#workspace-selection"
    >
      Select a workspace
    </Link>
  );

  const formatDate = (value: Date | null) => {
    if (!value) return "Unknown";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value);
  };
  const periodLabel = planPeriodStart && planPeriodEnd
    ? `${formatDate(planPeriodStart)} - ${formatDate(planPeriodEnd)}`
    : "Unknown";

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute top-40 left-10 h-[400px] w-[400px] rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative flex min-h-screen flex-col md:flex-row">
        <PlanSidebar
          isSidebarOpen={isSidebarOpen}
          primaryProject={primaryProject}
          me={me}
          userInitial={userInitial}
          onLogout={handleLogout}
        />
        <div className="flex-1">
          <PlanHeader
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
            profileOpen={profileOpen}
            onToggleProfile={() => setProfileOpen((prev) => !prev)}
            profileMenuRef={profileMenuRef}
            userInitial={userInitial}
            userEmail={userEmail}
            userName={userName}
            primaryRole={primaryRole}
            onLogout={handleLogout}
          />
          <div className="w-full px-6 pb-12 pt-8">

        {loading ? (
          <div className="mt-6 rounded-xl border border-black/10 bg-white/70 px-4 py-2 text-xs text-black/60">
            Loading plan details...
          </div>
        ) : null}
        <div className="mb-10">
          <p className="text-xs font-medium uppercase tracking-wider text-black/40">Plan & usage</p>
          <h1 className="mt-1 text-2xl font-semibold text-black/90">Usage overview</h1>
          <p className="mt-1 text-sm text-black/60">
            {activeOrg ? `Workspace: ${activeOrg.org_name}` : "Personal workspace"}
          </p>
        </div>
        {needsPlanSelection ? (
          <div
            id="workspace-selection"
            className="mb-8 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-600">
              Select a workspace
            </p>
            <p className="mt-1 text-sm font-semibold">
              Choose a workspace to view its plan &amp; usage details.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                className="rounded-full border border-sky-200 bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-700 transition hover:border-sky-300"
                href="/dashboard/plan"
              >
                Personal plan
              </Link>
              {me?.memberships?.map((membership) => (
                <Link
                  key={membership.org_id}
                  className="rounded-full border border-sky-200 bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-700 transition hover:border-sky-300"
                  href={`/dashboard/plan?org_id=${membership.org_id}`}
                >
                  {membership.org_name}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {error && !needsPlanSelection ? (
          <div className="mb-8 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            {error}
          </div>
        ) : null}

        {isGated ? (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 shadow-sm shadow-amber-100/60">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-700">
              AI gated
            </p>
            <p className="mt-1 text-sm font-semibold">AI analyzer is limited on your current plan.</p>
            <p className="mt-1 text-xs text-amber-700/80">
              {!aiEnabled
                ? "AI is disabled for this workspace."
                : creditExhausted
                  ? "Daily AI credits are exhausted."
                  : isLimitReached
                    ? "Your AI usage has reached the monthly limit for this period."
                    : "Upgrade to unlock AI analyzer features."}
            </p>
            {upgradeAvailable ? (
              <a
                href="#upgrade"
                className="mt-3 inline-flex items-center rounded-full bg-amber-700 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white transition hover:bg-amber-600"
              >
                Upgrade
              </a>
            ) : null}
          </div>
        ) : null}
        {creditNotice && !creditExhausted && !needsPlanSelection ? (
          <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sky-800 shadow-sm shadow-sky-100/60">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700">
              Credit notice
            </p>
            <p className="mt-1 text-sm font-semibold">{creditNotice}</p>
          </div>
        ) : null}

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Current plan
                </p>
                {needsPlanSelection ? (
                  <Link
                    className="mt-2 inline-flex text-sm font-semibold text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-800"
                    href="#workspace-selection"
                  >
                    Select a workspace
                  </Link>
                ) : (
                  <p className="mt-2 text-xl font-semibold text-black/90">{planName}</p>
                )}
              </div>
              <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-black/60">
                {planId}
              </span>
            </div>
            <div className="mt-4 grid gap-3 text-sm text-black/70">
              <div className="flex items-center justify-between rounded-xl border border-black/10 bg-white/80 px-3 py-2">
                <span>AI analyzer</span>
                {needsPlanSelection ? (
                  selectionLink
                ) : (
                  <span className={`text-xs font-semibold ${aiStatusClass}`}>{aiStatusLabel}</span>
                )}
              </div>
              <div className="flex items-center justify-between rounded-xl border border-black/10 bg-white/80 px-3 py-2">
                <span>Upgrade availability</span>
                {needsPlanSelection ? (
                  selectionLink
                ) : (
                  <span className="text-xs font-semibold text-black/70">
                    {upgradeStatusLabel}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
              Usage
            </p>
            <p className="mt-2 text-sm font-semibold text-black/80">
              {creditSystemEnabled ? "Daily AI credits remaining" : "AI-assisted actions"}
            </p>
            <p className="mt-2 text-2xl font-semibold text-black/90">
              {needsPlanSelection ? (
                <Link
                  className="text-base font-semibold text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-800"
                  href="#workspace-selection"
                >
                  Select a workspace
                </Link>
              ) : (
                usageLimitLabel
              )}
            </p>
            <p className="mt-1 text-xs text-black/50">
              {creditSystemEnabled
                ? `Grace credits used: ${graceUsed === null ? "Unknown" : graceUsed ? "Yes" : "No"}`
                : `Period: ${periodLabel}`}
            </p>
            <div className="mt-4 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-xs text-black/60">
              {creditSystemEnabled
                ? "Credits reset daily (UTC)."
                : "Counts only. No token or cost details yet."}
            </div>
          </div>
        </section>

        <section
          id="upgrade"
          className="mt-8 rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm shadow-black/5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/40">
                Upgrade
              </p>
              <h2 className="mt-1 text-lg font-semibold text-black/90">Request an upgrade</h2>
              <p className="mt-1 text-sm text-black/60">
                Share your team size or AI usage needs. We will follow up shortly.
              </p>
            </div>
            {upgradeAvailable ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                Upgrade ready
              </span>
            ) : null}
          </div>

          {upgradeStatus === "sent" ? (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Upgrade request sent. We will be in touch soon.
            </div>
          ) : null}
          {upgradeError ? (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">
              {upgradeError}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3">
            <textarea
              className="min-h-[120px] w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm text-black/70 shadow-sm shadow-black/5 focus:border-black/30 focus:outline-none"
              placeholder="Tell us about your usage needs..."
              value={upgradeMessage}
              onChange={(event) => setUpgradeMessage(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-full bg-black px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white transition hover:-translate-y-0.5 hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleUpgradeRequest}
                disabled={upgradeStatus === "sending"}
              >
                {upgradeStatus === "sending" ? "Sending..." : "Send request"}
              </button>
              {resolvedOrgId ? (
                <span className="text-xs text-black/50">Requesting for org {resolvedOrgId}</span>
              ) : (
                <span className="text-xs text-black/50">Requesting for {userEmail}</span>
              )}
            </div>
          </div>
        </section>
          </div>
        </div>
      </div>
    </div>
  );
}

type PlanSidebarProps = {
  isSidebarOpen: boolean;
  primaryProject: Project | null;
  me: MeResponse | null;
  userInitial: string;
  onLogout: () => void;
};

function PlanSidebar({
  isSidebarOpen,
  primaryProject,
  me,
  userInitial,
  onLogout,
}: PlanSidebarProps) {
  return (
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
            aria-current="page"
            className={`relative flex items-center rounded-xl border border-white/10 bg-white/10 py-2 text-sm font-semibold text-white shadow-sm shadow-black/30 ${
              isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
            }`}
            href="/dashboard/plan"
            title="Plan & usage"
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
                <path d="M4 7h16" />
                <path d="M4 12h16" />
                <path d="M4 17h10" />
              </svg>
            </span>
            <span className={isSidebarOpen ? "" : "hidden"}>Plan & usage</span>
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
              className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white ${
                isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
              }`}
              href={`/projects/${primaryProject.id}/analyses`}
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
          {primaryProject ? (
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-sm font-semibold text-white">{primaryProject.name}</span>
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
            <p className="mt-1 text-sm text-white">{me?.user?.email ?? "Unknown"}</p>
            <button
              className="mt-3 w-full rounded-full border border-white/10 bg-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white transition hover:bg-white/20"
              onClick={onLogout}
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
  );
}

type PlanHeaderProps = {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  profileOpen: boolean;
  onToggleProfile: () => void;
  profileMenuRef: { current: HTMLDivElement | null };
  userInitial: string;
  userEmail: string;
  userName: string;
  primaryRole: string;
  onLogout: () => void;
};

function PlanHeader({
  isSidebarOpen,
  onToggleSidebar,
  profileOpen,
  onToggleProfile,
  profileMenuRef,
  userInitial,
  userEmail,
  userName,
  primaryRole,
  onLogout,
}: PlanHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 shadow-sm shadow-black/5 backdrop-blur-sm">
      <div className="flex w-full flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            aria-controls="primary-navigation"
            aria-expanded={isSidebarOpen}
            aria-label="Toggle navigation"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white text-black/60"
            onClick={onToggleSidebar}
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
            <p className="text-[11px] uppercase tracking-[0.2em] text-black/40">Billing</p>
            <div className="flex items-center gap-2 text-sm font-semibold text-black/80">
              <span>Plan</span>
              <span className="text-black/30">/</span>
              <span>Usage</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
              onClick={onToggleProfile}
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
                    onClick={onToggleProfile}
                    type="button"
                  >
                    Profile
                  </button>
                  <button
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-black/70 hover:bg-black/5"
                    onClick={onToggleProfile}
                    type="button"
                  >
                    Settings
                  </button>
                  <Link
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-black/70 hover:bg-black/5"
                    href="/dashboard/plan"
                    onClick={onToggleProfile}
                  >
                    Plan &amp; usage
                  </Link>
                </div>
                <div className="mt-2 border-t border-black/10 pt-2">
                  <button
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-500 hover:bg-rose-50"
                    onClick={onLogout}
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
  );
}
