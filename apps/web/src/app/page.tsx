import Link from "next/link";

const links = [
  {
    href: "/events",
    title: "Browse events",
    description: "Published events with their static seat maps.",
  },
  {
    href: "/events",
    title: "Event details",
    description: "Open any event from the list to see its full seat grid.",
  },
  {
    href: "/signup",
    title: "Sign up",
    description: "Create an attendee or organizer account.",
  },
  {
    href: "/login",
    title: "Log in",
    description: "Organizers are taken straight to the event builder.",
  },
  {
    href: "/organizer/events/new",
    title: "Create an event",
    description: "Build a seat layout, create the event and publish it.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-10 p-8">
      <header className="space-y-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight">SeatSync</h1>
        <p className="mx-auto max-w-xl text-lg text-slate-600">
          Event booking that never sells the same seat twice.
        </p>
      </header>

      <nav className="grid gap-4 sm:grid-cols-2">
        {links.map((link) => (
          <Link
            key={`${link.href}-${link.title}`}
            href={link.href}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-slate-400 hover:shadow"
          >
            <h2 className="text-lg font-semibold text-slate-900">{link.title}</h2>
            <p className="mt-1 text-sm text-slate-600">{link.description}</p>
          </Link>
        ))}
      </nav>

      <p className="text-center text-xs text-slate-500">
        API docs are served by the API at <span className="font-mono">/docs</span>.
      </p>
    </main>
  );
}
