"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearAccessToken, logout } from "@/lib/api";

/**
 * One logout flow for the nav and the profile page. The server call revokes the
 * refresh token and clears the cookie; the local token is cleared no matter
 * what, so a failed request cannot leave the UI claiming to be signed in.
 */
export function LogoutButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout(): Promise<void> {
    setPending(true);

    try {
      await logout();
    } catch (error) {
      console.warn(
        "SeatSync: the server could not end the session; clearing the local token anyway.",
        error,
      );
    } finally {
      clearAccessToken();
      setPending(false);
      router.push("/");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleLogout()}
      disabled={pending}
      className={`rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-900 disabled:opacity-60 ${className}`}
    >
      {pending ? "Logging out…" : "Log out"}
    </button>
  );
}
