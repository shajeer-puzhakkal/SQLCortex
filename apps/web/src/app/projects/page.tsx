"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const SIDEBAR_STATE_KEY = "sqlcortex.sidebarOpen";

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

type ConnectionRecord = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  ssl_mode: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  uses_url: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
};

const ACTIVE_PROJECT_KEY = "sqlcortex.activeProjectId";

export default function ProjectsPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("");
  const [projectOrgId, setProjectOrgId] = useState("personal");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editProjectName, setEditProjectName] = useState("");
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [showConnectionsProject, setShowConnectionsProject] = useState<Project | null>(null);
  const [connectionsByProject, setConnectionsByProject] = useState<
    Record<string, ConnectionRecord[]>
  >({});
  const [connectionsLoadingId, setConnectionsLoadingId] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [addConnectionProject, setAddConnectionProject] = useState<Project | null>(null);
  const [connectionName, setConnectionName] = useState("");
  const [connectionMode, setConnectionMode] = useState<"fields" | "url">("fields");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [sslMode, setSslMode] = useState("require");
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTestStatus, setConnectionTestStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const orgOptions = useMemo(() => me?.memberships ?? [], [me]);
  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    orgOptions.forEach((org) => {
      map.set(org.org_id, org.org_name);
    });
    return map;
  }, [orgOptions]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );
  const primaryProject = activeProject ?? projects[0] ?? null;

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
        setError("Please sign in to view projects.");
        setLoading(false);
        return;
      }

      const mePayload = (await meResponse.json()) as MeResponse;
      const projectsPayload = (await projectsResponse.json()) as { projects: Project[] };
      setMe(mePayload);
      setProjects(projectsPayload.projects ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load projects";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
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

  const handleLogout = async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  };

  const handleCreateProject = async () => {
    if (!projectName.trim()) {
      toast.error("Project name is required.");
      return;
    }
    setError(null);
    const orgId = projectOrgId === "personal" ? null : projectOrgId;
    const response = await fetch(`${API_BASE}/api/v1/projects`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName.trim(), org_id: orgId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toast.error(payload?.message ?? "Failed to create project.");
      return;
    }
    setProjectName("");
    setIsCreateOpen(false);
    toast.success("Project created.");
    await loadData();
  };

  const resetConnectionForm = () => {
    setConnectionName("");
    setConnectionMode("fields");
    setHost("");
    setPort("5432");
    setDatabase("");
    setUsername("");
    setPassword("");
    setConnectionUrl("");
    setSslMode("require");
  };

  const loadConnectionsForProject = async (projectId: string) => {
    setConnectionsError(null);
    setConnectionsLoadingId(projectId);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/connections`, {
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.message ?? "Failed to load connections.";
        setConnectionsError(message);
        toast.error(message);
        return;
      }
      const payload = (await response.json()) as { connections?: ConnectionRecord[] };
      setConnectionsByProject((prev) => ({
        ...prev,
        [projectId]: payload.connections ?? [],
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load connections.";
      setConnectionsError(message);
      toast.error(message);
    } finally {
      setConnectionsLoadingId(null);
    }
  };

  const openConnectionsModal = (project: Project) => {
    setConnectionsError(null);
    setShowConnectionsProject(project);
    void loadConnectionsForProject(project.id);
  };

  const openAddConnectionModal = (project: Project) => {
    setConnectionsError(null);
    setConnectionTestStatus(null);
    setAddConnectionProject(project);
    resetConnectionForm();
  };

  const handleCreateConnection = async (projectId: string, testAfter = false) => {
    if (!connectionName.trim()) {
      setConnectionsError("Connection name is required.");
      return;
    }

    const payload: Record<string, unknown> = {
      name: connectionName.trim(),
      type: "postgres",
      ssl_mode: sslMode,
    };

    if (connectionMode === "url") {
      if (!connectionUrl.trim()) {
        setConnectionsError("Connection URL is required.");
        return;
      }
      payload.connection_url = connectionUrl.trim();
    } else {
      if (!host.trim()) {
        setConnectionsError("Host is required.");
        return;
      }
      if (!database.trim()) {
        setConnectionsError("Database is required.");
        return;
      }
      if (!username.trim()) {
        setConnectionsError("Username is required.");
        return;
      }
      const parsedPort = Number(port);
      if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
        setConnectionsError("Port must be a valid number.");
        return;
      }
      payload.host = host.trim();
      payload.port = parsedPort;
      payload.database = database.trim();
      payload.username = username.trim();
      if (password) {
        payload.password = password;
      }
    }

    setConnectionsError(null);
    setConnectionTestStatus(null);
    setIsSavingConnection(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/connections`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.message ?? "Failed to create connection.";
        setConnectionsError(message);
        toast.error(message);
        return;
      }
      const created = (await response.json()) as { connection?: ConnectionRecord };
      if (created.connection) {
        setConnectionsByProject((prev) => ({
          ...prev,
          [projectId]: [created.connection, ...(prev[projectId] ?? [])],
        }));
      } else {
        await loadConnectionsForProject(projectId);
      }
      let testOk: boolean | null = null;
      if (testAfter && created.connection?.id) {
        setIsTestingConnection(true);
        const testResponse = await fetch(
          `${API_BASE}/api/v1/connections/${created.connection.id}/test`,
          { method: "POST", credentials: "include" }
        );
        if (!testResponse.ok) {
          const payload = await testResponse.json().catch(() => null);
          setConnectionTestStatus({
            ok: false,
            message: payload?.message ?? "Connection test failed.",
          });
          testOk = false;
        } else {
          setConnectionTestStatus({ ok: true, message: "Connection successful." });
          testOk = true;
        }
      }
      toast.success("Connection saved.");
      if (!testAfter || testOk !== false) {
        resetConnectionForm();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create connection.";
      setConnectionsError(message);
      toast.error(message);
    } finally {
      setIsSavingConnection(false);
      setIsTestingConnection(false);
    }
  };

  const handleUpdateProject = async () => {
    if (!editProject) {
      return;
    }
    if (!editProjectName.trim()) {
      toast.error("Project name is required.");
      return;
    }
    setIsSavingProject(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${editProject.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editProjectName.trim() }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.message ?? "Failed to update project.");
        return;
      }
      toast.success("Project updated.");
      setEditProject(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update project.");
    } finally {
      setIsSavingProject(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!deleteProject) {
      return;
    }
    setIsDeletingProject(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${deleteProject.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.message ?? "Failed to delete project.");
        return;
      }
      if (activeProjectId === deleteProject.id) {
        setActiveProjectId(null);
      }
      setConnectionsByProject((prev) => {
        const next = { ...prev };
        delete next[deleteProject.id];
        return next;
      });
      toast.success("Project deleted.");
      setDeleteProject(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete project.");
    } finally {
      setIsDeletingProject(false);
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
                aria-current="page"
                className={`relative flex items-center rounded-xl border border-white/10 bg-white/10 py-2 text-sm font-semibold text-white shadow-sm shadow-black/30 ${
                  isSidebarOpen ? "gap-3 px-3" : "justify-center px-2"
                }`}
                href="/projects"
                title="Projects"
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
                    <span>Projects</span>
                    <span className="text-black/30">/</span>
                    <span>{me?.user?.name ?? "Workspace"}</span>
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
                Syncing projects...
              </div>
            ) : null}
            <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-black/40">Workspace</p>
                <h1 className="mt-1 text-2xl font-semibold text-black/90">
                  {me?.user?.name ?? "My Projects"}
                </h1>
                <p className="mt-1 text-sm text-black/60">
                  Manage your databases and AI query optimizations.
                </p>
              </div>
              <button
                className="rounded-full bg-black px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80"
                onClick={() => setIsCreateOpen(true)}
              >
                Create project
              </button>
            </div>

            <div className="grid gap-8">
              <section className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Projects</h2>
                    <p className="mt-1 text-sm text-black/60">
                      Choose a project to open the analysis workspace.
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    {projects.length} total
                  </span>
                </div>

                <div className="mt-6 overflow-hidden rounded-2xl border border-black/10 bg-white/70">
                  <div className="hidden grid-cols-[1.6fr_1fr_0.6fr_auto] items-center gap-4 border-b border-black/10 bg-black/5 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-black/50 md:grid">
                    <span>Project</span>
                    <span>Connections</span>
                    <span>Status</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <div className="divide-y divide-black/5">
                    {projects.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-black/60">No projects yet.</div>
                    ) : (
                      projects.map((project) => {
                        const isActive = activeProjectId === project.id;
                        const orgName = project.org_id
                          ? orgNameById.get(project.org_id) ?? "Org"
                          : "Personal";
                        const connectionCount = connectionsByProject[project.id]?.length;
                        const connectionLabel =
                          typeof connectionCount === "number"
                            ? `${connectionCount} connection${connectionCount === 1 ? "" : "s"}`
                            : "Click show";

                        return (
                          <div
                            key={project.id}
                            className={`flex flex-col gap-3 px-4 py-4 md:grid md:grid-cols-[1.6fr_1fr_0.6fr_auto] md:items-center md:gap-4 ${
                              isActive ? "bg-cyan-50/50" : "bg-white"
                            }`}
                          >
                            <div>
                              <p className="text-sm font-semibold text-black/80">{project.name}</p>
                              <p className="mt-1 text-xs text-black/50">
                                {orgName} {project.org_id ? "workspace" : "project"}
                              </p>
                            </div>
                            <div className="text-xs text-black/60">
                              <span className="font-semibold text-black/70 md:hidden">
                                Connections:{" "}
                              </span>
                              {connectionLabel}
                            </div>
                            <div>
                              {isActive ? (
                                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                                  Active
                                </span>
                              ) : (
                                <button
                                  className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5"
                                  onClick={() => setActiveProjectId(project.id)}
                                >
                                  Set active
                                </button>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 md:justify-end">
                              <button
                                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5"
                                onClick={() => {
                                  setEditProject(project);
                                  setEditProjectName(project.name);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                className="rounded-full border border-rose-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-rose-600 transition hover:border-rose-300 hover:bg-rose-50"
                                onClick={() => setDeleteProject(project)}
                              >
                                Delete
                              </button>
                              <button
                                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5"
                                onClick={() => openAddConnectionModal(project)}
                              >
                                Add connection
                              </button>
                              <button
                                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5"
                                onClick={() => openConnectionsModal(project)}
                              >
                                Show connections
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>
            </div>

        </div>
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
                  Workspace
                </p>
                <h2 className="mt-1 text-lg font-semibold text-black/90">Create project</h2>
              </div>
              <button
                className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                onClick={() => setIsCreateOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <input
                className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                placeholder="Project name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
              {orgOptions.length > 0 && (
                <select
                  className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                  value={projectOrgId}
                  onChange={(event) => setProjectOrgId(event.target.value)}
                >
                  <option value="personal">Personal</option>
                  {orgOptions.map((org) => (
                    <option key={org.org_id} value={org.org_id}>
                      {org.org_name} ({org.role})
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-black/50">
                Projects contain databases, queries, and AI analysis.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => setIsCreateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-full bg-black px-5 py-2 text-xs font-semibold text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80"
                  onClick={handleCreateProject}
                >
                  Create project
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {editProject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
          onClick={() => setEditProject(null)}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-black/10 px-6 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Project settings
                </p>
                <h2 className="mt-1 text-lg font-semibold text-black/90">Edit project</h2>
              </div>
              <button
                className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                onClick={() => setEditProject(null)}
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <input
                className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                placeholder="Project name"
                value={editProjectName}
                onChange={(event) => setEditProjectName(event.target.value)}
              />
              <p className="text-xs text-black/50">
                Update the project name for dashboards and workspace lists.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => setEditProject(null)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-full bg-black px-5 py-2 text-xs font-semibold text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={handleUpdateProject}
                  disabled={isSavingProject}
                >
                  {isSavingProject ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {deleteProject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
          onClick={() => setDeleteProject(null)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-black/10 px-6 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Danger zone
                </p>
                <h2 className="mt-1 text-lg font-semibold text-black/90">Delete project</h2>
              </div>
              <button
                className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                onClick={() => setDeleteProject(null)}
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <p className="text-sm text-black/70">
                This will permanently delete{" "}
                <span className="font-semibold text-black">{deleteProject.name}</span> and
                any saved connections. This action cannot be undone.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => setDeleteProject(null)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-full border border-rose-200 bg-rose-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-rose-500/20 transition hover:-translate-y-0.5 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={handleDeleteProject}
                  disabled={isDeletingProject}
                >
                  {isDeletingProject ? "Deleting..." : "Delete project"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showConnectionsProject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
          onClick={() => {
            setShowConnectionsProject(null);
            setConnectionsError(null);
          }}
        >
          <div
            className="w-full max-w-4xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/10 px-6 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Connections
                </p>
                <h2 className="mt-1 text-lg font-semibold text-black/90">
                  {showConnectionsProject.name}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => {
                    openAddConnectionModal(showConnectionsProject);
                    setShowConnectionsProject(null);
                  }}
                >
                  Add connection
                </button>
                <button
                  className="rounded-full border border-black/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => {
                    setShowConnectionsProject(null);
                    setConnectionsError(null);
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="space-y-4 px-6 py-5">
              {connectionsLoadingId === showConnectionsProject.id ? (
                <div className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-black/60">
                  Loading connections...
                </div>
              ) : null}
              {connectionsError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {connectionsError}
                </div>
              ) : null}
              <div className="space-y-3">
                {(connectionsByProject[showConnectionsProject.id] ?? []).length === 0 ? (
                  <div className="rounded-xl border border-dashed border-black/10 px-3 py-4 text-sm text-black/50">
                    No connections yet. Add one to test access.
                  </div>
                ) : (
                  (connectionsByProject[showConnectionsProject.id] ?? []).map((connection) => {
                    const hostLabel = connection.host ?? "hidden";
                    const dbLabel = connection.database ?? "hidden";
                    const userLabel = connection.username ?? "hidden";
                    const methodLabel = connection.uses_url ? "URL" : "Host";

                    return (
                      <div
                        key={connection.id}
                        className="rounded-xl border border-black/5 bg-white px-4 py-3 text-sm shadow-sm shadow-black/5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-black/80">{connection.name}</p>
                            <p className="text-xs text-black/50">{methodLabel} connection</p>
                          </div>
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                            {connection.ssl_mode}
                          </span>
                        </div>
                        <div className="mt-4 grid gap-3 text-xs text-black/50 sm:grid-cols-2">
                          <div>
                            <p className="font-semibold text-black/60">Host</p>
                            <p>
                              {hostLabel}
                              {connection.port ? `:${connection.port}` : ""}
                            </p>
                          </div>
                          <div>
                            <p className="font-semibold text-black/60">Database</p>
                            <p>{dbLabel}</p>
                          </div>
                          <div>
                            <p className="font-semibold text-black/60">Username</p>
                            <p>{userLabel}</p>
                          </div>
                          <div>
                            <p className="font-semibold text-black/60">Password stored</p>
                            <p>{connection.has_password ? "Yes" : "No"}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {addConnectionProject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
          onClick={() => {
            setAddConnectionProject(null);
            setConnectionsError(null);
            setConnectionTestStatus(null);
            resetConnectionForm();
          }}
        >
          <div
            className="w-full max-w-3xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/10 px-6 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-black/40">
                  Add connection
                </p>
                <h2 className="mt-1 text-lg font-semibold text-black/90">
                  {addConnectionProject.name}
                </h2>
              </div>
              <button
                className="rounded-full border border-black/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-black/70 transition hover:border-black/30 hover:bg-black/5"
                onClick={() => {
                  setAddConnectionProject(null);
                  setConnectionsError(null);
                  setConnectionTestStatus(null);
                  resetConnectionForm();
                }}
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              {connectionsError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {connectionsError}
                </div>
              ) : null}
              {connectionTestStatus ? (
                <div
                  className={`rounded-xl border px-3 py-2 text-xs ${
                    connectionTestStatus.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}
                >
                  {connectionTestStatus.message}
                </div>
              ) : null}
              <div className="grid gap-3">
                <input
                  className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                  placeholder="Connection name"
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                />
                <select
                  className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                  value={connectionMode}
                  onChange={(event) =>
                    setConnectionMode(event.target.value as "fields" | "url")
                  }
                >
                  <option value="fields">Use host credentials</option>
                  <option value="url">Use connection URL</option>
                </select>
                {connectionMode === "url" ? (
                  <input
                    className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                    placeholder="postgresql://user:pass@host:5432/db"
                    value={connectionUrl}
                    onChange={(event) => setConnectionUrl(event.target.value)}
                  />
                ) : (
                  <>
                    <input
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                      placeholder="Host"
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                        placeholder="Port"
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                      />
                      <input
                        className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                        placeholder="Database"
                        value={database}
                        onChange={(event) => setDatabase(event.target.value)}
                      />
                    </div>
                    <input
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                      placeholder="Username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                    <input
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                      placeholder="Password (optional)"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </>
                )}
                <select
                  className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-cyan-600 focus:shadow-sm focus:shadow-cyan-900/5"
                  value={sslMode}
                  onChange={(event) => setSslMode(event.target.value)}
                >
                  <option value="require">SSL require</option>
                  <option value="prefer">SSL prefer</option>
                  <option value="disable">SSL disable</option>
                  <option value="verify-full">SSL verify-full</option>
                  <option value="verify-ca">SSL verify-ca</option>
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                  onClick={() => {
                    setAddConnectionProject(null);
                    setConnectionsError(null);
                    setConnectionTestStatus(null);
                    resetConnectionForm();
                  }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() =>
                    addConnectionProject
                      ? handleCreateConnection(addConnectionProject.id, false)
                      : undefined
                  }
                  disabled={isSavingConnection || isTestingConnection}
                >
                  {isSavingConnection ? "Saving..." : "Save connection"}
                </button>
                <button
                  className="rounded-full bg-black px-5 py-2 text-xs font-semibold text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() =>
                    addConnectionProject
                      ? handleCreateConnection(addConnectionProject.id, true)
                      : undefined
                  }
                  disabled={isSavingConnection || isTestingConnection}
                >
                  {isTestingConnection ? "Testing..." : "Save and test"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
