import type { UserRole } from "@seatsync/shared";

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

const paiseFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date);
}

/** Integer paise (the database unit) to an INR currency string. */
export function formatPaise(paise: number): string {
  return paiseFormatter.format(paise / 100);
}

/** A `UserRole` as the label shown in the nav badge and profile card. */
export function formatRole(role: UserRole): string {
  return role === "ORGANIZER" ? "Organizer" : "Attendee";
}
