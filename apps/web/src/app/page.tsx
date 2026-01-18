import Link from "next/link";
import { cookies } from "next/headers";
import type { CSSProperties, ReactNode } from "react";

function Icon({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5 shadow-sm shadow-black/30">
      {children}
    </span>
  );
}

async function getIsSignedIn() {
  const cookieStore = await cookies();
  const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? "sc_session";
  if (!cookieStore.get(sessionCookieName)) {
    return false;
  }

  const apiBase =
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    "http://localhost:4000";

  try {
    const cookieHeader = cookieStore
      .getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    const response = await fetch(`${apiBase}/api/v1/me`, {
      headers: { Cookie: cookieHeader },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

const fadeUp = (delay = 0): CSSProperties => ({
  animation: "fade-up 0.75s ease-out both",
  animationDelay: `${delay}s`,
});

const floatSlow: CSSProperties = {
  animation: "float 10s ease-in-out infinite",
};

const floatSlowAlt: CSSProperties = {
  animation: "float 12s ease-in-out infinite",
  animationDelay: "1.2s",
};

export default async function Home() {
  const isSignedIn = await getIsSignedIn();
  const themeStyles: CSSProperties = {
    "--bg": "#0b0f14",
    "--bg-soft": "#111821",
    "--card": "rgba(255, 255, 255, 0.06)",
    "--card-strong": "rgba(255, 255, 255, 0.1)",
    "--text": "#f5f3ee",
    "--text-muted": "#b8b4aa",
    "--accent": "#59d3b8",
    "--accent-2": "#f2b26b",
    "--border": "rgba(255, 255, 255, 0.12)",
  };

  return (
    <div
      className="relative min-h-[100svh] bg-[var(--bg)] text-[color:var(--text)]"
      style={themeStyles}
    >
      <div className="absolute inset-0 -z-10 bg-[var(--bg)]" />
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-48 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,_rgba(89,211,184,0.25),_transparent_68%)]" />
        <div className="absolute -bottom-72 right-0 h-[620px] w-[620px] rounded-full bg-[radial-gradient(circle,_rgba(242,178,107,0.35),_transparent_70%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(140deg,_rgba(255,255,255,0.06),_rgba(255,255,255,0)_45%,_rgba(255,255,255,0.05))]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 pb-16 pt-8 sm:px-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link
            className="text-sm font-semibold uppercase tracking-[0.38em] text-white/70"
            href="/"
          >
            SQLCortex
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-[11px] font-semibold uppercase tracking-[0.28em] text-white/50">
            <Link className="hover:text-white" href="/#features">
              Features
            </Link>
            <Link className="hover:text-white" href="/#how">
              Workflow
            </Link>
            <Link className="hover:text-white" href="/#pricing">
              Pricing
            </Link>
            <Link className="hover:text-white" href="/#faq">
              FAQ
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {isSignedIn ? (
              <Link
                className="rounded-full border border-transparent px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60 hover:text-white"
                href="/projects"
              >
                Projects
              </Link>
            ) : null}
            <Link
              className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white hover:border-white/40"
              href="/login"
            >
              Sign in
            </Link>
            <Link
              className="rounded-full bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-black hover:bg-white/90"
              href="/signup"
            >
              Sign up
            </Link>
          </div>
        </header>

        <main className="flex-1">
          <section className="pt-12 sm:pt-16">
            <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
              <div style={fadeUp(0.05)}>
                <span className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.32em] text-white/60">
                  Sprint 4
                  <span className="h-1 w-1 rounded-full bg-white/30" />
                  Pricing + Credits + Value Meter
                </span>
                <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
                  See SQL performance before it hits production.
                </h1>
                <p className="mt-5 max-w-xl text-lg leading-7 text-[color:var(--text-muted)]">
                  SQLCortex runs AI analysis where you write SQL, explains the risk, and tracks
                  value saved over time with clear credits and guardrails.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Link
                    className="rounded-full bg-white px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-black shadow-lg shadow-black/30 transition hover:-translate-y-0.5 hover:bg-white/90"
                    href="/signup"
                  >
                    Start free
                  </Link>
                  <Link
                    className="rounded-full border border-white/30 bg-white/5 px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:-translate-y-0.5 hover:border-white/50"
                    href="/login"
                  >
                    Sign in
                  </Link>
                  {isSignedIn ? (
                    <Link
                      className="px-2 py-3 text-sm font-semibold text-white/60 hover:text-white"
                      href="/projects"
                    >
                      Open projects
                    </Link>
                  ) : null}
                </div>
                <div className="mt-10 grid gap-4 sm:grid-cols-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                      VS Code ready
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                      Run analysis inline with your SQL editor.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                      Credit aware
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                      Estimate cost before running any AI action.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                      Multi-model
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                      Anthropic, OpenAI, and Gemini routing.
                    </p>
                  </div>
                </div>
              </div>

              <div className="relative" style={fadeUp(0.15)}>
                <div className="absolute -left-6 top-6 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/70 shadow-lg shadow-black/40" style={floatSlow}>
                  Multi-model routing
                </div>
                <div className="absolute -right-4 bottom-10 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/70 shadow-lg shadow-black/40" style={floatSlowAlt}>
                  Credits: 12
                </div>
                <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[var(--bg-soft)] shadow-2xl shadow-black/40">
                  <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-xs text-white/60">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-rose-400" />
                      <span className="h-2 w-2 rounded-full bg-amber-300" />
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    </div>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.3em]">
                      VS Code
                    </span>
                  </div>
                  <div className="p-5">
                    <div className="rounded-2xl border border-white/10 bg-[#0c1118] p-4 font-mono text-[11px] leading-5 text-white/70">
                      <div className="text-white/40">-- customer revenue rollup</div>
                      <div>WITH revenue AS (</div>
                      <div className="pl-4">
                        SELECT user_id, SUM(amount) AS total, COUNT(*) AS orders
                      </div>
                      <div className="pl-4">FROM orders</div>
                      <div className="pl-4">WHERE created_at &gt;= now() - interval '90 days'</div>
                      <div className="pl-4">GROUP BY user_id</div>
                      <div>)</div>
                      <div>SELECT u.email, r.total, r.orders</div>
                      <div>FROM users u</div>
                      <div>JOIN revenue r ON r.user_id = u.id</div>
                      <div>ORDER BY r.total DESC</div>
                      <div>LIMIT 200;</div>
                    </div>
                    <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
                      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.3em] text-emerald-200">
                        <span>SQLCortex Analyzer</span>
                        <span className="text-emerald-200/80">Running</span>
                      </div>
                      <ul className="mt-3 space-y-2 text-sm text-white/85">
                        <li>Add index: orders(created_at, user_id)</li>
                        <li>Filter users after revenue join to reduce scan</li>
                        <li>Estimated runtime drop: 38%</li>
                      </ul>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <p className="text-white/60">Query cost</p>
                        <p className="mt-2 text-lg font-semibold text-white">-38%</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <p className="text-white/60">Est. savings</p>
                        <p className="mt-2 text-lg font-semibold text-white">$4.2k</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <p className="text-white/60">Value meter</p>
                        <p className="mt-2 text-lg font-semibold text-white">+27</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-14 sm:mt-20">
            <div className="flex flex-wrap items-center gap-6 text-xs font-semibold uppercase tracking-[0.32em] text-white/40">
              <span>Model support</span>
              <span className="flex items-center gap-2 text-white/70">
                <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                Anthropic
              </span>
              <span className="flex items-center gap-2 text-white/70">
                <span className="h-2 w-2 rounded-full bg-white/60" />
                OpenAI
              </span>
              <span className="flex items-center gap-2 text-white/70">
                <span className="h-2 w-2 rounded-full bg-[var(--accent-2)]" />
                Gemini
              </span>
            </div>
          </section>

          <section id="features" className="mt-20 sm:mt-28">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/50">
                  Features
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Built for busy micro SaaS data teams.
                </h2>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Clear accountability, measurable AI value, and predictable costs.
                </p>
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                Sprint 4 focus
              </span>
            </div>
            <div className="mt-10 grid gap-6 lg:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <Icon>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-5 w-5 text-white/70"
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
                <h3 className="mt-4 text-lg font-semibold">Ownership clarity</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Projects stay scoped to a person or org, with roles, invites, and audit trails.
                </p>
                <ul className="mt-4 space-y-2 text-xs text-[color:var(--text-muted)]">
                  <li>Project-scoped API tokens</li>
                  <li>Org invites with roles</li>
                  <li>Attribution for every analysis</li>
                </ul>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <Icon>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-5 w-5 text-white/70"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 6V4m0 16v-2m8-6h-2M6 12H4m12.36 4.36-1.42-1.42M9.05 8.64 7.64 7.22m9.72 0-1.42 1.42M9.05 15.36 7.64 16.78"
                    />
                  </svg>
                </Icon>
                <h3 className="mt-4 text-lg font-semibold">Credit guardrails</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Daily credits, soft limits, and a clear upgrade path keep AI costs visible.
                </p>
                <ul className="mt-4 space-y-2 text-xs text-[color:var(--text-muted)]">
                  <li>Real-time credit estimates</li>
                  <li>Grace window before lockout</li>
                  <li>Plan-aware gating</li>
                </ul>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <Icon>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-5 w-5 text-white/70"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 12a8 8 0 0 1 16 0"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 12l3 3"
                    />
                  </svg>
                </Icon>
                <h3 className="mt-4 text-lg font-semibold">AI value meter</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Track saved time and avoided incidents with a daily AI value timeline.
                </p>
                <ul className="mt-4 space-y-2 text-xs text-[color:var(--text-muted)]">
                  <li>Timeline of AI actions</li>
                  <li>Value saved per day</li>
                  <li>Dashboard visibility</li>
                </ul>
              </div>
            </div>
          </section>

          <section id="how" className="mt-20 sm:mt-28">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/50">
                  Workflow
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  From SQL to decision in minutes.
                </h2>
              </div>
            </div>
            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">
                  Step 01
                </p>
                <h3 className="mt-3 text-lg font-semibold">Connect a project</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Add a data connection and create tokens for tools and teammates.
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">
                  Step 02
                </p>
                <h3 className="mt-3 text-lg font-semibold">Run AI analysis</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Explain, optimize, or rewrite SQL with clear credit estimates.
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">
                  Step 03
                </p>
                <h3 className="mt-3 text-lg font-semibold">Measure value</h3>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Review the AI value meter, share results, and plan upgrades.
                </p>
              </div>
            </div>
          </section>

          <section id="pricing" className="mt-20 sm:mt-28">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/50">
                  Pricing
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Simple tiers, transparent credits.
                </h2>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Start free, move to Pro when you want unlimited AI.
                </p>
              </div>
              {isSignedIn ? (
                <Link
                  className="rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-white hover:border-white/40"
                  href="/dashboard/plan"
                >
                  View plan
                </Link>
              ) : null}
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-7">
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                  Free
                </p>
                <p className="mt-3 text-4xl font-semibold text-white">$0</p>
                <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                  Daily AI credits included.
                </p>
                <ul className="mt-6 space-y-2 text-sm text-[color:var(--text-muted)]">
                  <li>100 daily AI credits (UTC reset)</li>
                  <li>All AI explain and optimization actions</li>
                  <li>Usage timeline + value meter</li>
                  <li>Community support</li>
                </ul>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    className="rounded-full bg-white px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-black transition hover:-translate-y-0.5 hover:bg-white/90"
                    href="/signup"
                  >
                    Start free
                  </Link>
                  <Link
                    className="rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white transition hover:border-white/40"
                    href="/login"
                  >
                    Sign in
                  </Link>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(140deg,_rgba(89,211,184,0.2),_rgba(16,24,33,0.95))] text-white">
                <div className="absolute right-6 top-6 rounded-full bg-white/15 px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-white/80">
                  Most popular
                </div>
                <div className="p-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
                    Pro
                  </p>
                  <p className="mt-3 text-4xl font-semibold">$20</p>
                  <p className="mt-1 text-sm text-white/70">Per month, unlimited AI.</p>
                  <ul className="mt-6 space-y-2 text-sm text-white/80">
                    <li>Unlimited AI analyzer usage</li>
                    <li>Priority indexing and rewrite guidance</li>
                    <li>Team-ready usage visibility</li>
                    <li>Priority support onboarding</li>
                  </ul>
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <Link
                      className="rounded-full bg-white px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-black transition hover:-translate-y-0.5"
                      href="/dashboard/plan#upgrade"
                    >
                      Upgrade to Pro
                    </Link>
                    <span className="text-xs text-white/60">No Stripe yet. Request upgrade.</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="faq" className="mt-20 sm:mt-28">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/50">
                  FAQ
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Answers before you ask.
                </h2>
              </div>
            </div>
            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-semibold">How do credits work?</p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Every AI action has an estimated credit cost. Free plans reset daily and show
                  soft limits before any lockout.
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-semibold">Which models do you use?</p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  SQLCortex routes work across Anthropic, OpenAI, and Gemini to match the task.
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-semibold">Which AI actions are included?</p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Explain, optimize, and rewrite actions are included on all plans.
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-semibold">Do you support org workspaces?</p>
                <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                  Org workspaces include roles, invites, and clear ownership boundaries for data
                  teams.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-20 sm:mt-28">
            <div className="relative overflow-hidden rounded-[36px] border border-white/10 bg-[linear-gradient(135deg,_rgba(89,211,184,0.2),_rgba(17,24,33,0.95))] p-10 shadow-lg shadow-black/40">
              <div className="absolute -right-10 top-1/2 h-48 w-48 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,_rgba(242,178,107,0.4),_transparent_70%)]" />
              <div className="relative max-w-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/60">
                  Ready to move?
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Bring your team into a measurable AI workflow.
                </h2>
                <p className="mt-3 text-sm text-[color:var(--text-muted)]">
                  Get started with free daily credits, then upgrade once you see the value meter
                  trend up.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    className="rounded-full bg-white px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-black transition hover:-translate-y-0.5 hover:bg-white/90"
                    href="/signup"
                  >
                    Start free today
                  </Link>
                  <Link
                    className="rounded-full border border-white/20 bg-white/5 px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-white hover:border-white/40"
                    href="/dashboard/plan"
                  >
                    View pricing
                  </Link>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="mt-16 border-t border-white/10 py-8 text-sm text-white/50">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>SQLCortex - Sprint 4</p>
            <p className="text-white/40">Versioned API routes only: /api/v1/*</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
