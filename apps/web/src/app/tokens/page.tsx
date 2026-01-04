"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";

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

type TokenRecord = {
  id: string;
  label: string | null;
  subject_type: "USER" | "ORG";
  subject_id: string;
  project_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export default function TokensPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);

  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenScope, setTokenScope] = useState<"user" | "org">("user");
  const [tokenOrgId, setTokenOrgId] = useState("");
  const [tokenProjectId, setTokenProjectId] = useState("");
  const [createdToken, setCreatedToken] = useState<{ token: string; tokenId: string } | null>(
    null
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [isCreating, setIsCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const orgOptions = useMemo(() => me?.memberships ?? [], [me]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );
  const primaryProject = activeProject ?? projects[0] ?? null;

  const projectLookup = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) {
      map.set(project.id, project);
    }
    return map;
  }, [projects]);

  const projectOptions = useMemo(() => {
    if (tokenScope === "org") {
      return projects.filter((project) => project.org_id === tokenOrgId);
    }
    return projects;
  }, [projects, tokenScope, tokenOrgId]);

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

  useEffect(() => {
    if (tokenScope === "user") {
      setTokenOrgId("");
    }
    setTokenProjectId("");
  }, [tokenScope]);

  useEffect(() => {
    if (tokenScope === "org" && !tokenOrgId && orgOptions.length > 0) {
      setTokenOrgId(orgOptions[0].org_id);
    }
  }, [tokenScope, tokenOrgId, orgOptions]);

  useEffect(() => {
    if (tokenProjectId && !projectOptions.find((project) => project.id === tokenProjectId)) {
      setTokenProjectId("");
    }
  }, [projectOptions, tokenProjectId]);

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
    setCopyStatus("idle");
  }, [createdToken]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [meResponse, tokensResponse, projectsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/tokens`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
      ]);

      if (meResponse.status === 401) {
        setError("Please sign in to manage API tokens.");
        setLoading(false);
        return;
      }

      const mePayload = (await meResponse.json()) as MeResponse;
      const tokensPayload = tokensResponse.ok
        ? ((await tokensResponse.json()) as { tokens: TokenRecord[] })
        : { tokens: [] };
      const projectsPayload = projectsResponse.ok
        ? ((await projectsResponse.json()) as { projects: Project[] })
        : { projects: [] };

      if (!tokensResponse.ok) {
        const payload = await tokensResponse.json().catch(() => null);
        setError(payload?.message ?? "Failed to load API tokens.");
      }
      if (!projectsResponse.ok) {
        const payload = await projectsResponse.json().catch(() => null);
        setError(payload?.message ?? "Failed to load projects.");
      }

      setMe(mePayload);
      setTokens(tokensPayload.tokens ?? []);
      setProjects(projectsPayload.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleLogout = async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  };

  const handleCreateToken = async () => {
    if (tokenScope === "org" && !tokenOrgId) {
      setError("Select an org for org-scoped tokens.");
      return;
    }
    setError(null);
    setIsCreating(true);

    const payload: {
      scope: string;
      label?: string;
      org_id?: string;
      project_id?: string;
    } = {
      scope: tokenScope,
    };

    if (tokenLabel.trim()) {
      payload.label = tokenLabel.trim();
    }
    if (tokenScope === "org" && tokenOrgId) {
      payload.org_id = tokenOrgId;
    }
    if (tokenProjectId) {
      payload.project_id = tokenProjectId;
    }

    try {
      const response = await fetch(`${API_BASE}/api/v1/tokens`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        setError(errorPayload?.message ?? "Failed to create token.");
        return;
      }

      const responsePayload = (await response.json()) as {
        token?: string;
        token_id?: string;
      };
      if (responsePayload.token) {
        setCreatedToken({
          token: responsePayload.token,
          tokenId: responsePayload.token_id ?? "",
        });
      }
      setTokenLabel("");
      setTokenProjectId("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    const confirmed = window.confirm("Revoke this API token? This cannot be undone.");
    if (!confirmed) {
      return;
    }
    setRevokingId(tokenId);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/v1/tokens/${tokenId}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "Failed to revoke token.");
        return;
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token.");
    } finally {
      setRevokingId(null);
    }
  };

  const handleCopyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
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

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute top-40 left-10 h-[400px] w-[400px] rounded-full bg-amber-300/20 blur-3xl" />
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
            <div
              className={`flex flex-col items-center text-center ${isSidebarOpen ? "gap-3" : "gap-2"}`}
            >
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
              <div
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/40 ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
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
              </div>
              <Link
                aria-current="page"
                className={`relative flex items-center rounded-xl border border-white/10 bg-white/10 py-2 text-sm font-semibold text-white shadow-sm shadow-black/30 ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/tokens"
                title="API tokens"
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
                    <path d="M12 7v10M7 12h10" />
                    <rect x="4" y="4" width="16" height="16" rx="4" />
                  </svg>
                </span>
                <span className={isSidebarOpen ? "" : "hidden"}>API tokens</span>
              </Link>
              <div
                className={`flex items-center rounded-xl py-2 text-sm font-semibold text-white/40 ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
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
              </div>
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
                  <p className="text-[11px] uppercase tracking-[0.2em] text-black/40">Home</p>
                  <div className="flex items-center gap-2 text-sm font-semibold text-black/80">
                    <span>Security</span>
                    <span className="text-black/30">/</span>
                    <span>API tokens</span>
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
            {loading ? (
              <div className="mb-6 rounded-xl border border-black/10 bg-white/70 px-4 py-2 text-xs text-black/60">
                Syncing tokens...
              </div>
            ) : null}
            <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-black/40">Security</p>
                <h1 className="mt-1 text-2xl font-semibold text-black/90">API tokens</h1>
                <p className="mt-1 text-sm text-black/60">
                  Create tokens for VS Code, CLI, or external automations.
                </p>
              </div>
              <button
                className="mt-1 rounded-full bg-black px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80"
                onClick={() => setIsCreateOpen(true)}
              >
                Create token
              </button>
            </div>

            {error ? (
              <div className="mb-8 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                {error}
              </div>
            ) : null}

            <div className="grid gap-8">
              <section className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Active tokens</h2>
                  <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-700">
                    {tokens.filter((token) => !token.revoked_at).length} live
                  </span>
                </div>
                <p className="mt-2 text-sm text-black/60">
                  Tokens are shown without secrets. Copy the raw token when created.
                </p>
                <div className="mt-6 space-y-3">
                  {tokens.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-black/10 px-3 py-4 text-sm text-black/50">
                      No tokens yet. Create one to connect VS Code.
                    </div>
                  ) : (
                    tokens.map((token) => {
                      const projectLabel = token.project_id
                        ? projectLookup.get(token.project_id)?.name ??
                          `${token.project_id.slice(0, 8)}...`
                        : "All projects";
                      const scopeLabel = token.subject_type === "ORG" ? "Org" : "User";
                      const createdAt = formatTimestamp(token.created_at);
                      const lastUsed = token.last_used_at ? formatTimestamp(token.last_used_at) : "Never";
                      return (
                        <div
                          key={token.id}
                          className="rounded-xl border border-black/5 bg-white px-4 py-3 text-sm shadow-sm shadow-black/5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-black/80">
                                {token.label?.trim() || "Untitled token"}
                              </p>
                              <p className="text-xs text-black/50">
                                {scopeLabel} token • {projectLabel}
                              </p>
                            </div>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                                token.revoked_at
                                  ? "bg-rose-100 text-rose-700"
                                  : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              {token.revoked_at ? "Revoked" : "Active"}
                            </span>
                          </div>
                          <div className="mt-4 grid gap-3 text-xs text-black/50 sm:grid-cols-2">
                            <div>
                              <p className="font-semibold text-black/60">Created</p>
                              <p>{createdAt}</p>
                            </div>
                            <div>
                              <p className="font-semibold text-black/60">Last used</p>
                              <p>{lastUsed}</p>
                            </div>
                            <div>
                              <p className="font-semibold text-black/60">Token ID</p>
                              <p>{token.id.slice(0, 12)}...</p>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <button
                              className="rounded-full border border-black/10 bg-white px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => handleRevokeToken(token.id)}
                              disabled={Boolean(token.revoked_at) || revokingId === token.id}
                            >
                              {token.revoked_at ? "Revoked" : revokingId === token.id ? "Revoking" : "Revoke"}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-black/5 bg-white/60 p-5 text-xs text-black/60 shadow-sm shadow-black/5 backdrop-blur-sm">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Token usage
                </p>
                <p className="mt-2">
                  Use tokens with <span className="font-semibold text-black/80">Authorization: Bearer</span>.
                </p>
                <div className="mt-3 rounded-xl border border-black/10 bg-white px-3 py-2 font-mono text-[11px] text-black/70">
                  Authorization: Bearer &lt;token&gt;
                </div>
              </section>
            </div>
          </div>

          {isCreateOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
              onClick={() => setIsCreateOpen(false)}
            >
              <div
                className="w-full max-w-xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-start justify-between border-b border-black/10 px-6 py-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                      Security
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-black/90">Create token</h2>
                  </div>
                  <button
                    className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                    onClick={() => setIsCreateOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="max-h-[70vh] space-y-6 overflow-y-auto px-6 py-5">
                  <div>
                    <p className="text-sm text-black/60">
                      Tokens are shown once. Copy and store them securely.
                    </p>
                    <div className="mt-4 grid gap-3">
                      <input
                        className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                        placeholder="Label (optional)"
                        value={tokenLabel}
                        onChange={(event) => setTokenLabel(event.target.value)}
                      />
                      <select
                        className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                        value={tokenScope}
                        onChange={(event) => setTokenScope(event.target.value as "user" | "org")}
                      >
                        <option value="user">User scope</option>
                        <option value="org">Org scope</option>
                      </select>
                      {tokenScope === "org" ? (
                        orgOptions.length > 0 ? (
                          <select
                            className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                            value={tokenOrgId}
                            onChange={(event) => setTokenOrgId(event.target.value)}
                          >
                            {orgOptions.map((org) => (
                              <option key={org.org_id} value={org.org_id}>
                                {org.org_name} ({org.role})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            You are not part of any orgs yet.
                          </div>
                        )
                      ) : null}
                      <select
                        className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                        value={tokenProjectId}
                        onChange={(event) => setTokenProjectId(event.target.value)}
                        disabled={tokenScope === "org" && !tokenOrgId}
                      >
                        <option value="">All projects</option>
                        {projectOptions.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="rounded-full bg-black px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={handleCreateToken}
                        disabled={isCreating || (tokenScope === "org" && orgOptions.length === 0)}
                      >
                        {isCreating ? "Creating..." : "Create token"}
                      </button>
                    </div>
                  </div>

                  {createdToken ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-sm shadow-emerald-900/5">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                        New token
                      </p>
                      <p className="mt-2 text-sm text-emerald-800">
                        Copy this token now. It will not be shown again.
                      </p>
                      <div className="mt-3 rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs text-emerald-900">
                        <span className="select-all font-semibold">{createdToken.token}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-full border border-emerald-300 bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-800 transition hover:border-emerald-400 hover:bg-emerald-100"
                          onClick={handleCopyToken}
                        >
                          {copyStatus === "copied"
                            ? "Copied"
                            : copyStatus === "failed"
                            ? "Copy failed"
                            : "Copy token"}
                        </button>
                        <button
                          className="rounded-full border border-emerald-300 bg-transparent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-800 transition hover:bg-emerald-100"
                          onClick={() => setCreatedToken(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
}
