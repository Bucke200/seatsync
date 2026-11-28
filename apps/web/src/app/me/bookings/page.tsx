import Link from "next/link";
import { MyBookingsList } from "@/components/my-bookings-list";

export default function MyBookingsPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <header className="space-y-1">
        <Link href="/" className="text-sm text-slate-500 underline">
          ← SeatSync home
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">My bookings</h1>
        <p className="text-slate-600">
          Every booking you started, newest first. Open one to follow its payment status.
        </p>
      </header>

      <MyBookingsList />
    </main>
  );
}
