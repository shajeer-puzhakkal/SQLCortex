"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-black/50">Projects</p>
            <h1 className="mt-2 text-3xl font-semibold">
              {me?.user?.name ?? me?.user?.email ?? "Workspace"}
            </h1>
          </div>
          <button
            className="rounded-full border border-black/30 px-4 py-2 text-xs uppercase tracking-[0.3em] text-black transition hover:border-black"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>

        {error ? <p className="mt-6 text-sm text-rose-600">{error}</p> : null}

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
          <section className="rounded-3xl border border-black/10 bg-white/80 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Active projects</h2>
              {activeProjectId ? (
                <span className="text-xs uppercase tracking-[0.3em] text-white/60">
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
                    className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm transition ${
                      activeProjectId === project.id
                        ? "border-cyan-600/60 bg-cyan-100"
                        : "border-black/10 bg-white hover:border-black/30"
                    }`}
                    onClick={() => setActiveProjectId(project.id)}
                  >
                    <div>
                      <p className="font-semibold">{project.name}</p>
                      <p className="text-xs text-black/60">
                        {project.org_id
                          ? `Org ${project.org_id.slice(0, 8)}`
                          : "Personal"}
                      </p>
                    </div>
                    {activeProjectId === project.id ? (
                      <span className="text-xs uppercase tracking-[0.3em] text-cyan-700">
                        Active
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            <div className="mt-6 border-t border-black/10 pt-6">
              <h3 className="text-sm font-semibold text-black/70">Create project</h3>
              <div className="mt-4 grid gap-3">
                <input
                  className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-cyan-600"
                  placeholder="Project name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
                <select
                  className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-cyan-600"
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
                <button
                  className="rounded-full bg-black px-4 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white transition hover:-translate-y-0.5"
                  onClick={handleCreateProject}
                >
                  Create project
                </button>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="rounded-3xl border border-black/10 bg-white/80 p-6">
              <h2 className="text-lg font-semibold">Organizations</h2>
              <div className="mt-4 space-y-2">
                {orgOptions.length === 0 ? (
                  <p className="text-sm text-black/60">No org memberships yet.</p>
                ) : (
                  orgOptions.map((org) => (
                    <div
                      key={org.org_id}
                      className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm"
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
                    className="flex-1 rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                    placeholder="Org name"
                    value={orgName}
                    onChange={(event) => setOrgName(event.target.value)}
                  />
                  <button
                    className="rounded-full bg-black px-4 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white transition hover:-translate-y-0.5"
                    onClick={handleCreateOrg}
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-black/10 bg-white/80 p-6">
              <h2 className="text-lg font-semibold">Invite members</h2>
              <p className="mt-2 text-sm text-black/60">
                Invite teammates and share the token once.
              </p>
              <div className="mt-4 grid gap-3">
                <select
                  className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
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
                  className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                  placeholder="Invite email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
                <select
                  className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  className="rounded-full bg-black px-4 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white transition hover:-translate-y-0.5"
                  onClick={handleInvite}
                >
                  Create invite
                </button>
                {inviteToken ? (
                  <div className="rounded-2xl border border-emerald-300/60 bg-emerald-100 px-4 py-3 text-xs text-emerald-800">
                    Invite token: <span className="font-semibold">{inviteToken}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
