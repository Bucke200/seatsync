"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoutButton } from "@/components/logout-button";
import { MyBookingsList } from "@/components/my-bookings-list";
import { AUTH_CHANGE_EVENT, getAuthUser, type AuthUser } from "@/lib/api";
import { formatRole } from "@/lib/format";

export default function ProfilePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    function sync(): void {
      setUser(getAuthUser());
      setReady(true);
    }

    sync();
    window.addEventListener(AUTH_CHANGE_EVENT, sync);

    return () => {
      window.removeEventListener(AUTH_CHANGE_EVENT, sync);
    };
  }, []);

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <header className="space-y-1">
        <Link href="/" className="text-sm text-slate-500 underline">
          ← SeatSync home
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Your profile</h1>
        <p className="text-slate-600">Account details and every booking you started.</p>
      </header>

      {!ready ? <p className="text-slate-600">Loading your profile…</p> : null}

      {ready && user === null ? (
        <section className="space-y-4 rounded-2xl border border-dashed border-slate-300 p-8 text-center">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Log in to see your profile</h2>
            <p className="text-slate-600">
              Your account details and bookings live here once you are signed in.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-800"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
            >
              Create an account
            </Link>
          </div>
        </section>
      ) : null}

      {user !== null ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-xl font-semibold text-white"
                >
                  {user.email.charAt(0).toUpperCase()}
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Signed in as
                  </p>
                  <h2 className="text-xl font-semibold text-slate-900">{user.email}</h2>
                  <span className="mt-1 inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                    {formatRole(user.role)}
                  </span>
                </div>
              </div>

              <LogoutButton />
            </div>
          </section>

          <section id="bookings" className="scroll-mt-24 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Bookings</h2>
                <p className="text-slate-600">
                  Every booking you started, newest first. Open one to follow its payment status.
                </p>
              </div>
              <Link href="/me/bookings" className="text-sm text-slate-500 underline">
                Open the full bookings page
              </Link>
            </div>

            <MyBookingsList />
          </section>
        </>
      ) : null}
    </main>
  );
}
