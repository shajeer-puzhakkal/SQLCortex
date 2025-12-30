"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/signup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "Signup failed");
        return;
      }
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f4ee] text-[#1b1b1b]">
      <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-3xl border border-black/10 bg-white/80 p-8 shadow-xl shadow-black/10">
          <h1 className="text-3xl font-semibold">Create your account</h1>
          <p className="mt-2 text-sm text-black/60">
            Personal projects are ready immediately. Org workspaces come next.
          </p>
          <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
            <label className="block text-xs uppercase tracking-[0.2em] text-black/60">
              Name
              <input
                className="mt-2 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="block text-xs uppercase tracking-[0.2em] text-black/60">
              Email
              <input
                className="mt-2 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="block text-xs uppercase tracking-[0.2em] text-black/60">
              Password
              <input
                className="mt-2 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-black outline-none transition focus:border-emerald-600"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? <p className="text-sm text-rose-600">{error}</p> : null}
            <button
              className="w-full rounded-full bg-black px-4 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={loading}
            >
              {loading ? "Creating..." : "Create account"}
            </button>
          </form>
          <p className="mt-6 text-sm text-black/60">
            Already have an account?{" "}
            <a className="text-black underline" href="/login">
              Sign in
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
