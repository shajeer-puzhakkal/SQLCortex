"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

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

export default function ProjectConnectionsPage() {
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
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [connectionName, setConnectionName] = useState("");
  const [connectionMode, setConnectionMode] = useState<"fields" | "url">("fields");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [sslMode, setSslMode] = useState("require");
  const [isCreating, setIsCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId]
  );

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (stored) {
      setActiveProjectId(stored);
    }
  }, []);

  useEffect(() => {
    if (projectId) {
      setActiveProjectId(projectId);
    }
  }, [projectId]);

  useEffect(() => {
    if (activeProjectId) {
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    }
  }, [activeProjectId]);

  const loadData = async () => {
    if (!projectId) {
      setError("Select a project to manage database connections.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [meResponse, projectsResponse, connectionsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/me`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/projects`, { credentials: "include" }),
        fetch(`${API_BASE}/api/v1/projects/${projectId}/connections`, {
          credentials: "include",
        }),
      ]);

      if (meResponse.status === 401) {
        setError("Please sign in to manage database connections.");
        setLoading(false);
        return;
      }

      const mePayload = (await meResponse.json()) as MeResponse;
      const projectsPayload = projectsResponse.ok
        ? ((await projectsResponse.json()) as { projects: Project[] })
        : { projects: [] };
      const connectionsPayload = connectionsResponse.ok
        ? ((await connectionsResponse.json()) as { connections: ConnectionRecord[] })
        : { connections: [] };

      if (!projectsResponse.ok) {
        const payload = await projectsResponse.json().catch(() => null);
        setError(payload?.message ?? "Failed to load projects.");
      }
      if (!connectionsResponse.ok) {
        const payload = await connectionsResponse.json().catch(() => null);
        setError(payload?.message ?? "Failed to load connections.");
      }

      setMe(mePayload);
      setProjects(projectsPayload.projects ?? []);
      setConnections(connectionsPayload.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connections");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [projectId]);

  const handleLogout = async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  };

  const handleCreateConnection = async () => {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    if (!connectionName.trim()) {
      setError("Connection name is required.");
      return;
    }

    const payload: Record<string, unknown> = {
      name: connectionName.trim(),
      type: "postgres",
      ssl_mode: sslMode,
    };

    if (connectionMode === "url") {
      if (!connectionUrl.trim()) {
        setError("Connection URL is required.");
        return;
      }
      payload.connection_url = connectionUrl.trim();
    } else {
      if (!host.trim()) {
        setError("Host is required.");
        return;
      }
      if (!database.trim()) {
        setError("Database is required.");
        return;
      }
      if (!username.trim()) {
        setError("Username is required.");
        return;
      }
      const parsedPort = Number(port);
      if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
        setError("Port must be a valid number.");
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

    setError(null);
    setIsCreating(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/connections`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "Failed to create connection.");
        return;
      }

      setConnectionName("");
      setHost("");
      setDatabase("");
      setUsername("");
      setPassword("");
      setConnectionUrl("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create connection.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleTestConnection = async (connectionId: string) => {
    setTestingId(connectionId);
    setTestStatus(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/v1/connections/${connectionId}/test`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setTestStatus({
          id: connectionId,
          ok: false,
          message: payload?.message ?? "Connection test failed.",
        });
        return;
      }
      setTestStatus({ id: connectionId, ok: true, message: "Connection successful." });
    } catch (err) {
      setTestStatus({
        id: connectionId,
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed.",
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteConnection = async (connectionId: string) => {
    const confirmed = window.confirm("Delete this connection? This cannot be undone.");
    if (!confirmed) {
      return;
    }
    setDeletingId(connectionId);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/v1/connections/${connectionId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "Failed to delete connection.");
        return;
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete connection.");
    } finally {
      setDeletingId(null);
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

  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute top-40 left-10 h-[400px] w-[400px] rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-12 pt-8">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-black/40">
              Project settings
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-black/90">
              Database connections
            </h1>
            <p className="mt-1 text-sm text-black/60">
              Store read-only database credentials for schema discovery and query execution.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-black outline-none transition hover:border-black/30 focus:border-cyan-600"
              value={currentProject?.id ?? ""}
              onChange={(event) => router.push(`/projects/${event.target.value}/connections`)}
            >
              <option value="" disabled>
                Select project
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {currentProject ? (
              <Link
                className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black shadow-sm shadow-black/5 transition hover:border-black/30 hover:bg-black/5"
                href={`/projects/${currentProject.id}/analyses`}
              >
                Analyses
              </Link>
            ) : null}
            <Link
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black shadow-sm shadow-black/5 transition hover:border-black/30 hover:bg-black/5"
              href="/projects"
            >
              Projects
            </Link>
            <button
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black shadow-sm shadow-black/5 transition hover:border-black/30 hover:bg-black/5"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        </header>

        {loading ? (
          <div className="mb-6 rounded-xl border border-black/10 bg-white/70 px-4 py-2 text-xs text-black/60">
            Loading connections...
          </div>
        ) : null}

        {error ? (
          <div className="mb-8 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
          <section className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Connections</h2>
              <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-700">
                {connections.length} total
              </span>
            </div>
            <p className="mt-2 text-sm text-black/60">
              Credentials are encrypted at rest. Passwords are never returned after save.
            </p>
            <div className="mt-6 space-y-3">
              {connections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-black/10 px-3 py-4 text-sm text-black/50">
                  No connections yet. Add one to test access.
                </div>
              ) : (
                connections.map((connection) => {
                  const hostLabel = connection.host ?? "hidden";
                  const dbLabel = connection.database ?? "hidden";
                  const userLabel = connection.username ?? "hidden";
                  const methodLabel = connection.uses_url ? "URL" : "Host";
                  const testForConnection =
                    testStatus && testStatus.id === connection.id ? testStatus : null;

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
                      {testForConnection ? (
                        <div
                          className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
                            testForConnection.ok
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-rose-200 bg-rose-50 text-rose-700"
                          }`}
                        >
                          {testForConnection.message}
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-full border border-black/10 bg-white px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-black transition hover:border-black/30 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => handleTestConnection(connection.id)}
                          disabled={testingId === connection.id}
                        >
                          {testingId === connection.id ? "Testing" : "Test"}
                        </button>
                        <button
                          className="rounded-full border border-rose-200 bg-white px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-rose-600 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => handleDeleteConnection(connection.id)}
                          disabled={deletingId === connection.id}
                        >
                          {deletingId === connection.id ? "Deleting" : "Delete"}
                        </button>
                        <span className="text-[11px] text-black/40">
                          Added {formatTimestamp(connection.created_at)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
            <h2 className="text-lg font-semibold">Add connection</h2>
            <p className="mt-2 text-sm text-black/60">
              Provide either host credentials or a full connection URL.
            </p>
            <div className="mt-4 grid gap-3">
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
              <button
                className="rounded-full bg-black px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleCreateConnection}
                disabled={isCreating}
              >
                {isCreating ? "Saving..." : "Save connection"}
              </button>
            </div>
          </section>
        </div>

        <div className="mt-10 text-xs text-black/50">
          Signed in as {userName} ({userEmail})
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
