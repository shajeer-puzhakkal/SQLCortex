"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

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

const ACTIVE_PROJECT_KEY = "sqlcortex.activeProjectId";

export default function ProjectsPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [orgName, setOrgName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteOrgId, setInviteOrgId] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("");
  const [projectOrgId, setProjectOrgId] = useState("personal");

  const orgOptions = useMemo(() => me?.memberships ?? [], [me]);

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (stored) {
      setActiveProjectId(stored);
    }
  }, []);

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
      setError(err instanceof Error ? err.message : "Failed to load projects");
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

  const handleCreateOrg = async () => {
    if (!orgName.trim()) {
      setError("Org name is required.");
      return;
    }
    const response = await fetch(`${API_BASE}/api/v1/orgs`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: orgName.trim() }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.message ?? "Failed to create org.");
      return;
    }
    setOrgName("");
    await loadData();
  };

  const handleInvite = async () => {
    if (!inviteOrgId) {
      setError("Choose an org to invite into.");
      return;
    }
    if (!inviteEmail.trim()) {
      setError("Invite email is required.");
      return;
    }
    const response = await fetch(`${API_BASE}/api/v1/orgs/${inviteOrgId}/invites`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.message ?? "Failed to invite member.");
      return;
    }
    const payload = (await response.json()) as { token?: string };
    setInviteToken(payload.token ?? null);
    setInviteEmail("");
  };

  const handleCreateProject = async () => {
    if (!projectName.trim()) {
      setError("Project name is required.");
      return;
    }
    const orgId = projectOrgId === "personal" ? null : projectOrgId;
    const response = await fetch(`${API_BASE}/api/v1/projects`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName.trim(), org_id: orgId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.message ?? "Failed to create project.");
      return;
    }
    setProjectName("");
    await loadData();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
        <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6 py-16">
          <p className="text-black/70">Loading projects...</p>
        </div>
      </div>
    );
  }

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

      <header className="sticky top-0 z-50 border-b border-black/5 bg-white/70 px-6 py-4 backdrop-blur-md transition-all">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/SQLCortexLogo.png"
              alt="SQLCortex"
              width={32}
              height={32}
              className="h-8 w-auto"
            />
            <span className="text-lg font-bold tracking-tight text-black">SQLCortex</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-xs text-black/50 sm:block">
              {me?.user?.email}
            </div>
            <button
              className="rounded-full border border-black/10 bg-white px-4 py-1.5 text-xs font-medium text-black transition hover:border-black/30 hover:bg-black/5"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto max-w-5xl px-6 py-12">
        <div className="mb-10">
          <p className="text-xs font-medium uppercase tracking-wider text-black/40">Workspace</p>
          <h1 className="mt-1 text-2xl font-semibold text-black/90">
            {me?.user?.name ?? "My Projects"}
          </h1>
          <p className="mt-1 text-sm text-black/60">
            Manage your databases and AI query optimizations.
          </p>
        </div>

        {error ? (
          <div className="mb-8 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            {error}
          </div>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <section className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Active projects</h2>
              {activeProjectId ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  Active
                </span>
              ) : null}
            </div>
            <div className="mt-6 space-y-3">
              {projects.length === 0 ? (
                <p className="text-sm text-black/60">No projects yet.</p>
              ) : (
                projects.map((project) => (
                  <button
                    key={project.id}
                    className={`group flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-sm transition ${activeProjectId === project.id
                      ? "border-cyan-600/40 bg-cyan-50/50 shadow-sm shadow-cyan-900/5"
                      : "border-black/5 bg-white hover:border-black/20 hover:shadow-sm hover:shadow-black/5"
                      }`}
                    onClick={() => setActiveProjectId(project.id)}
                  >
                    <div>
                      <p className="font-semibold">{project.name}</p>
                      <p className="mt-0.5 text-xs text-black/60">
                        {project.org_id
                          ? `Org ${project.org_id.slice(0, 8)}`
                          : "Personal"}{" "}
                        • Not connected
                      </p>
                    </div>
                    {activeProjectId === project.id ? (
                      <div className="h-2 w-2 rounded-full bg-cyan-500 shadow-sm shadow-cyan-500/50" />
                    ) : null}
                  </button>
                ))
              )}
            </div>
            <div className="mt-6 border-t border-black/10 pt-6">
              <h3 className="text-sm font-semibold text-black/70">Create project</h3>
              <div className="mt-4 grid gap-3">
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
                <button
                  className="rounded-full bg-black px-5 py-2 text-xs font-semibold text-white shadow-md shadow-black/5 transition hover:-translate-y-0.5 hover:bg-black/80"
                  onClick={handleCreateProject}
                >
                  Create project
                </button>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
              <h2 className="text-lg font-semibold">Organizations</h2>
              <div className="mt-4 space-y-2">
                {orgOptions.length === 0 ? (
                  <p className="text-sm text-black/60">
                    Create an organization to collaborate with your team and share projects.
                  </p>
                ) : (
                  orgOptions.map((org) => (
                    <div
                      key={org.org_id}
                      className="rounded-xl border border-black/5 bg-white px-3 py-2 text-sm"
                    >
                      <p className="font-semibold">{org.org_name}</p>
                      <p className="text-xs text-black/60">{org.role}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-6 border-t border-black/10 pt-6">
                <h3 className="text-sm font-semibold text-black/70">Create org</h3>
                <div className="mt-3 flex gap-3">
                  <input
                    className="flex-1 rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-emerald-600 focus:shadow-sm focus:shadow-emerald-900/5"
                    placeholder="Org name"
                    value={orgName}
                    onChange={(event) => setOrgName(event.target.value)}
                  />
                  <button
                    className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                    onClick={handleCreateOrg}
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>



            <div className="rounded-2xl border border-black/5 bg-white/60 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
              <h2 className="text-lg font-semibold">Invite members</h2>
              {orgOptions.length === 0 ? (
                <p className="mt-2 text-sm text-black/60">
                  Create an organization to invite team members.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-black/60">
                    Invite teammates and share the token once.
                  </p>
                  <div className="mt-4 grid gap-3">
                    <select
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-emerald-600 focus:shadow-sm focus:shadow-emerald-900/5"
                      value={inviteOrgId ?? ""}
                      onChange={(event) => setInviteOrgId(event.target.value || null)}
                    >
                      <option value="">Choose org</option>
                      {orgOptions.map((org) => (
                        <option key={org.org_id} value={org.org_id}>
                          {org.org_name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black placeholder:text-black/40 outline-none transition focus:border-emerald-600 focus:shadow-sm focus:shadow-emerald-900/5"
                      placeholder="Invite email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                    <select
                      className="w-full rounded-xl border border-black/5 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-emerald-600 focus:shadow-sm focus:shadow-emerald-900/5"
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value)}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black transition hover:border-black/30 hover:bg-black/5"
                      onClick={handleInvite}
                    >
                      Create invite
                    </button>
                    {inviteToken ? (
                      <div className="rounded-xl border border-emerald-300/60 bg-emerald-100 px-3 py-2 text-xs text-emerald-800">
                        Invite token: <span className="font-semibold select-all">{inviteToken}</span>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        <div className="mt-12 border-t border-black/5 pt-8">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-black/40">
            Next steps
          </p>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <div>
              <span className="block text-2xl font-bold text-black/10">01</span>
              <p className="mt-2 text-sm font-medium text-black/80">Create a project</p>
            </div>
            <div>
              <span className="block text-2xl font-bold text-black/10">02</span>
              <p className="mt-2 text-sm font-medium text-black/80">
                Connect your database
              </p>
            </div>
            <div>
              <span className="block text-2xl font-bold text-black/10">03</span>
              <p className="mt-2 text-sm font-medium text-black/80">
                Analyze and optimize queries with AI
              </p>
            </div>
          </div>
        </div>
      </div >
    </div >
  );
}
