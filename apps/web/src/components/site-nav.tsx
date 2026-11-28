"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoutButton } from "@/components/logout-button";
import { AUTH_CHANGE_EVENT, getAuthUser, type AuthUser } from "@/lib/api";
import { formatRole } from "@/lib/format";

/**
 * Root-site nav. It re-reads the session on mount and on every
 * `seatsync:auth` event, so login, signup and logout swap the controls
 * immediately without waiting for a page load.
 */
export function SiteNav() {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    function sync(): void {
      setUser(getAuthUser());
    }

    sync();
    window.addEventListener(AUTH_CHANGE_EVENT, sync);

    return () => {
      window.removeEventListener(AUTH_CHANGE_EVENT, sync);
    };
  }, []);

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-bold tracking-tight text-slate-900">
            SeatSync
          </Link>
          <Link
            href="/events"
            className="hidden text-sm font-medium text-slate-600 transition hover:text-slate-900 sm:block"
          >
            Browse events
          </Link>
        </div>

        <nav aria-label="Account" className="flex flex-wrap items-center gap-3 text-sm">
          {user === null ? (
            <>
              <Link
                href="/login"
                className="rounded-lg border border-slate-300 px-3 py-2 font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white transition hover:bg-slate-800"
              >
                Sign up
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/profile"
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-1 pr-3 transition hover:border-slate-400 hover:bg-white"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white"
                >
                  {user.email.charAt(0).toUpperCase()}
                </span>
                <span className="max-w-[18rem] truncate">
                  <span className="font-medium text-slate-900">{user.email}</span>
                  <span className="text-slate-500"> · {formatRole(user.role)}</span>
                </span>
              </Link>

              <Link
                href="/profile#bookings"
                className="px-2 py-2 font-medium text-slate-700 transition hover:text-slate-900"
              >
                Bookings
              </Link>

              <LogoutButton />
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
