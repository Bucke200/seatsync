"use client";

import { SignupRequestSchema, type UserRole } from "@seatsync/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiClientError, setAccessToken, signup } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("ATTENDEE");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = SignupRequestSchema.safeParse({ email, password, role });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check your details.");
      return;
    }

    setSubmitting(true);

    try {
      const session = await signup(parsed.data);
      setAccessToken(session.accessToken);
      router.push(session.user.role === "ORGANIZER" ? "/organizer/events/new" : "/events");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Signup failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="w-full max-w-md space-y-5 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
          <p className="text-sm text-slate-600">Sign up as an attendee or an organizer.</p>
        </header>

        <label className="block text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
        </label>

        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">At least 8 characters.</span>
        </label>

        <label className="block text-sm font-medium text-slate-700">
          Role
          <select
            value={role}
            onChange={(event) =>
              setRole(event.target.value === "ORGANIZER" ? "ORGANIZER" : "ATTENDEE")
            }
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          >
            <option value="ATTENDEE">Attendee</option>
            <option value="ORGANIZER">Organizer</option>
          </select>
        </label>

        {error !== null ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>

        <p className="text-center text-sm text-slate-600">
          Already registered?{" "}
          <Link href="/login" className="font-medium text-slate-900 underline">
            Log in
          </Link>
        </p>
      </form>
    </main>
  );
}
