import Link from "next/link";
import type { ReactNode } from "react";

function Icon({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-black/10 bg-white shadow-sm shadow-black/5">
      {children}
    </span>
  );
}

export default function Home() {
  return (
    <div className="relative min-h-screen bg-[#f8f4ee] text-[#141414]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-cyan-300/30 blur-3xl" />
        <div className="absolute -bottom-52 left-10 h-[520px] w-[520px] rounded-full bg-amber-300/30 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-10 sm:px-10">
        <header className="flex items-center justify-between gap-6">
          <Link
            className="text-sm font-semibold uppercase tracking-[0.35em] text-black/70"
            href="/"
          >
            SQLCortex
          </Link>
          <nav className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em]">
            <Link
              className="rounded-full border border-transparent px-4 py-2 text-black/60 hover:text-black"
              href="/projects"
            >
              Projects
            </Link>
            <Link
              className="rounded-full border border-black/20 bg-white/50 px-4 py-2 text-black hover:border-black/40"
              href="/login"
            >
              Sign in
            </Link>
            <Link
              className="rounded-full bg-black px-4 py-2 text-white hover:bg-black/90"
              href="/signup"
            >
              Sign up
            </Link>
          </nav>
        </header>

        <main className="pt-14 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <section>
              <p className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/70 px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-black/70">
                Sprint 1
                <span className="h-1 w-1 rounded-full bg-black/30" />
                Auth + Orgs + Projects + Tokens
              </p>
              <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
                A clean ownership model for SQL analysis you can trust.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-7 text-black/70">
                Work in personal projects or org workspaces, invite teammates with roles, and
                automate non-browser clients using project-scoped API tokens.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Link
                  className="rounded-full bg-black px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:bg-black/90"
                  href="/signup"
                >
                  Create account
                </Link>
                <Link
                  className="rounded-full border border-black/30 bg-white/60 px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-black transition hover:-translate-y-0.5 hover:border-black/50"
                  href="/login"
                >
                  Sign in
                </Link>
                <Link className="px-2 py-3 text-sm font-semibold text-black/70 hover:text-black" href="/projects">
                  Open projects →
                </Link>
              </div>
              <div className="mt-10 grid gap-4 sm:grid-cols-3">
                <div className="rounded-3xl border border-black/10 bg-white/70 p-4 shadow-sm shadow-black/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-black/60">
                    Sessions
                  </p>
                  <p className="mt-2 text-sm text-black/70">
                    Browser auth via httpOnly cookies.
                  </p>
                </div>
                <div className="rounded-3xl border border-black/10 bg-white/70 p-4 shadow-sm shadow-black/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-black/60">
                    Invites
                  </p>
                  <p className="mt-2 text-sm text-black/70">
                    Owner/admin roles for org access.
                  </p>
                </div>
                <div className="rounded-3xl border border-black/10 bg-white/70 p-4 shadow-sm shadow-black/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-black/60">
                    Tokens
                  </p>
                  <p className="mt-2 text-sm text-black/70">
                    Hashed, revocable, project-scoped.
                  </p>
                </div>
              </div>
            </section>

            <section className="relative">
              <div className="absolute -inset-6 rounded-[32px] bg-gradient-to-br from-cyan-200/40 via-white/0 to-amber-200/40 blur-2xl" />
              <div className="relative overflow-hidden rounded-[32px] border border-black/10 bg-white/70 shadow-xl shadow-black/10">
                <div className="flex items-center justify-between border-b border-black/10 px-6 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-black/60">
                    Workspace preview
                  </p>
                  <p className="text-xs text-black/50">v1</p>
                </div>
                <div className="grid gap-4 p-6 sm:grid-cols-2">
                  <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm shadow-black/5">
                    <div className="flex items-start gap-4">
                      <Icon>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-5 w-5 text-black/70"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 21s-8-4.5-8-11a4.5 4.5 0 0 1 8-2.6A4.5 4.5 0 0 1 20 10c0 6.5-8 11-8 11Z"
                          />
                        </svg>
                      </Icon>
                      <div>
                        <p className="text-sm font-semibold">Personal projects</p>
                        <p className="mt-1 text-sm text-black/60">
                          Keep experiments private by default.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm shadow-black/5">
                    <div className="flex items-start gap-4">
                      <Icon>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-5 w-5 text-black/70"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M7 20a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H7Z"
                          />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9h8M8 13h5" />
                        </svg>
                      </Icon>
                      <div>
                        <p className="text-sm font-semibold">Org workspaces</p>
                        <p className="mt-1 text-sm text-black/60">
                          Invite teammates with roles.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm shadow-black/5 sm:col-span-2">
                    <div className="flex items-start gap-4">
                      <Icon>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-5 w-5 text-black/70"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M16 11V7a4 4 0 0 0-8 0v4"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 11h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8Z"
                          />
                        </svg>
                      </Icon>
                      <div className="flex-1">
                        <p className="text-sm font-semibold">Tokens for non-browser clients</p>
                        <p className="mt-1 text-sm text-black/60">
                          Authenticate via bearer token. Hashes only, revocable.
                        </p>
                        <div className="mt-4 rounded-2xl border border-black/10 bg-black/[0.03] px-4 py-3 font-mono text-[12px] leading-6 text-black/70">
                          <div>Authorization: Bearer {"<token>"}</div>
                          <div>POST /api/v1/analyses</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="mt-16 sm:mt-24">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-black/50">
                  Phase 02
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Built around a single source of truth for permissions.
                </h2>
              </div>
              <Link
                className="rounded-full border border-black/20 bg-white/70 px-5 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-black hover:border-black/40"
                href="/projects"
              >
                View projects
              </Link>
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-black/10 bg-white/70 p-6 shadow-sm shadow-black/5">
                <p className="text-sm font-semibold">Identity</p>
                <p className="mt-2 text-sm leading-6 text-black/70">
                  First-party auth with sessions for browsers and bearer tokens for tools.
                </p>
              </div>
              <div className="rounded-3xl border border-black/10 bg-white/70 p-6 shadow-sm shadow-black/5">
                <p className="text-sm font-semibold">Ownership</p>
                <p className="mt-2 text-sm leading-6 text-black/70">
                  Projects are either personal or org-owned (never both).
                </p>
              </div>
              <div className="rounded-3xl border border-black/10 bg-white/70 p-6 shadow-sm shadow-black/5">
                <p className="text-sm font-semibold">Attribution</p>
                <p className="mt-2 text-sm leading-6 text-black/70">
                  Every analysis request carries user/org/project context for future auditing.
                </p>
              </div>
            </div>
          </section>
        </main>

        <footer className="mt-16 border-t border-black/10 py-8 text-sm text-black/60">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>SQLCortex • Sprint 1</p>
            <p className="text-black/50">Versioned API routes only: /api/v1/*</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
