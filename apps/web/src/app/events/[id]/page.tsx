"use client";

import {
  applySeatVersionFilter,
  mergeSeatSnapshot,
  type ErrorResponse,
  type EventDetail,
  type EventStatus,
  type Seat,
  type SeatStatus,
} from "@seatsync/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAccessToken,
  createCheckout,
  createHold,
  getAccessToken,
  getEvent,
  jwtSubject,
  refreshAccessToken,
  releaseHold,
  setAccessToken,
} from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

/**
 * D17: local copy of the seat-per-hold cap so the grid can stop selection at
 * six seats without a config endpoint. The server's `MAX_SEATS_PER_HOLD` is
 * authoritative and still answers 422 `TOO_MANY_SEATS`; this value only avoids
 * sending a request the web already knows will fail.
 */
const MAX_SEATS_PER_HOLD = 6;

/**
 * D30: Next.js rewrites proxy HTTP only, so the browser opens the API's `/ws`
 * directly. `NEXT_PUBLIC_WS_URL` is inlined by Next at build time; the fallback
 * is the local API port.
 */
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

/**
 * Reconnect policy (spec §331): start at 1 s and double up to a 15 s ceiling,
 * then keep retrying at the ceiling. The attempt counter is reset only after a
 * successful `subscribed` ack, so a flapping server cannot hammer `/ws`.
 */
const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Identity-guard marker in sessionStorage (per tab, survives a reload). It is
 * set immediately before a reload that re-renders the page as a different user,
 * so a session that still cannot authenticate after that reload stops instead
 * of reloading forever. `subscribed` clears it: a working socket proves the
 * stored token is usable again.
 */
const IDENTITY_RELOAD_FLAG = "seatsync.identityReloaded";

/** The exact spec wording for the "your seat was taken" notice. */
const SEAT_TAKEN_MESSAGE = "Seat just taken";
const SEAT_TAKEN_TOAST_MS = 4_000;

const SEAT_STATUS_STYLES: Record<SeatStatus, string> = {
  AVAILABLE:
    "border-green-300 bg-green-100 text-green-800 hover:border-green-600 hover:bg-green-200",
  HELD: "border-amber-300 bg-amber-100 text-amber-800",
  BOOKED: "border-red-300 bg-red-100 text-red-800",
};

const SELECTED_SEAT_STYLE = "border-slate-900 bg-slate-900 text-white";
const MY_HOLD_SEAT_STYLE = "border-blue-400 bg-blue-100 text-blue-800";

const EVENT_STATUS_STYLES: Record<EventStatus, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  PUBLISHED: "bg-green-100 text-green-800",
};

interface SeatRowGroup {
  rowLabel: string;
  seats: Seat[];
}

interface SectionGroup {
  name: string;
  pricePaise: number;
  rows: SeatRowGroup[];
}

interface ActiveHold {
  holdId: string;
  seatIds: string[];
  heldUntil: string;
}

interface OwnHeldSeat extends Seat {
  holdId: string;
  heldUntil: string;
}

/**
 * One seat inside a live update. This is the publisher's wire shape
 * (`apps/api/src/realtime/publisher.ts`), forwarded verbatim by the subscriber:
 * `{ eventId, seats: [{ id, status, version }] }`. It deliberately has no
 * `type` discriminator — only `auth_ok`, `subscribed` and `error` do — so seat
 * frames are recognised by shape.
 */
interface LiveSeatUpdate {
  id: string;
  status: SeatStatus;
  version: number;
}

interface LiveSeatFrame {
  eventId: string;
  seats: LiveSeatUpdate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeatStatus(value: unknown): value is SeatStatus {
  return value === "AVAILABLE" || value === "HELD" || value === "BOOKED";
}

function isLiveSeatUpdate(value: unknown): value is LiveSeatUpdate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isSeatStatus(value.status) &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version >= 0
  );
}

function isLiveSeatFrame(value: unknown): value is LiveSeatFrame {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    Array.isArray(value.seats) &&
    value.seats.every(isLiveSeatUpdate)
  );
}

function groupSeatsBySection(seats: Seat[]): SectionGroup[] {
  const sections = new Map<string, Map<string, Seat[]>>();

  for (const seat of seats) {
    const rows = sections.get(seat.section) ?? new Map<string, Seat[]>();
    const rowSeats = rows.get(seat.rowLabel) ?? [];
    rowSeats.push(seat);
    rows.set(seat.rowLabel, rowSeats);
    sections.set(seat.section, rows);
  }

  return [...sections.entries()].map(([name, rows]) => {
    const rowGroups = [...rows.entries()].map(([rowLabel, rowSeats]) => ({
      rowLabel,
      seats: [...rowSeats].sort((left, right) => left.number - right.number),
    }));
    const firstSeat = rowGroups[0]?.seats[0];

    return {
      name,
      pricePaise: firstSeat?.pricePaise ?? 0,
      rows: rowGroups,
    };
  });
}

/** D15: `GET /events/:id` exposes hold details only for the viewer's own seats. */
function isOwnHeldSeat(seat: Seat): seat is OwnHeldSeat {
  return (
    seat.heldByMe === true &&
    typeof seat.holdId === "string" &&
    typeof seat.heldUntil === "string"
  );
}

/**
 * Re-attach to an existing hold after a reload. D8 allows at most one active
 * hold per user per event, so the first own-held seat names the hold and the
 * rest of that hold's seats are grouped with it.
 */
function activeHoldFromEvent(detail: EventDetail): ActiveHold | null {
  const ownSeats = detail.seats.filter(isOwnHeldSeat);
  const first = ownSeats[0];

  if (first === undefined) {
    return null;
  }

  const seats = ownSeats.filter((seat) => seat.holdId === first.holdId);

  return {
    holdId: first.holdId,
    seatIds: seats.map((seat) => seat.id),
    heldUntil: first.heldUntil,
  };
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function seatLabel(seat: Seat): string {
  return `${seat.section} ${seat.rowLabel}${seat.number}`;
}

/** `details.seatIds` from a 409 envelope; defensive because `details` is unknown. */
function unavailableSeatIdsFrom(error: ErrorResponse): string[] {
  const details = error.error.details;

  if (typeof details !== "object" || details === null || !("seatIds" in details)) {
    return [];
  }

  const seatIds = (details as { seatIds?: unknown }).seatIds;

  if (!Array.isArray(seatIds)) {
    return [];
  }

  return seatIds.filter((id): id is string => typeof id === "string");
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [activeHold, setActiveHold] = useState<ActiveHold | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  /**
   * The current `holdError` is the logged-out prompt, so the banner links to
   * `/login` instead of looking like an API failure.
   */
  const [holdNeedsLogin, setHoldNeedsLogin] = useState(false);
  const [unavailableSeatIds, setUnavailableSeatIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /**
   * A monotonically increasing counter, not the message text: two taken seats
   * within one toast window must restart the 4 s dismiss timer even though the
   * visible wording is identical.
   */
  const [seatTakenToast, setSeatTakenToast] = useState(0);

  /**
   * D29: `seatId -> last applied version`. A lookup table for the stale filter,
   * never rendered, hence a ref and not state. It survives reconnects so an
   * in-flight retry cannot apply an older frame; a snapshot resets it.
   */
  const seatVersionsRef = useRef<Map<string, number>>(new Map());
  /** Latest selection for the socket handler without re-opening the socket. */
  const selectedSeatIdsRef = useRef<string[]>([]);
  /**
   * Seats in a hold request currently on the wire. A HELD frame for one of
   * these is our own hold, not "someone else took it", so it must not toast.
   */
  const holdInFlightSeatIdsRef = useRef<string[]>([]);

  useEffect(() => {
    selectedSeatIdsRef.current = selectedSeatIds;
  }, [selectedSeatIds]);

  // Minimal inline toast: auto-dismiss, no portal and no new dependency.
  useEffect(() => {
    if (seatTakenToast === 0) {
      return;
    }

    const timer = window.setTimeout(() => setSeatTakenToast(0), SEAT_TAKEN_TOAST_MS);

    return () => window.clearTimeout(timer);
  }, [seatTakenToast]);

  /**
   * Apply an authoritative `GET /events/:id` result to every piece of state
   * that derives from it. Both the REST refresh and the socket resync use this,
   * so a snapshot cannot diverge from a manual refresh.
   */
  const applyEventDetail = useCallback((detail: EventDetail): void => {
    setEvent(detail);
    setActiveHold(activeHoldFromEvent(detail));
    // A refresh can turn a selected seat into HELD/BOOKED; drop those ids so
    // the next request never includes a seat that is no longer selectable.
    setSelectedSeatIds((current) =>
      current.filter((id) =>
        detail.seats.some((seat) => seat.id === id && seat.status === "AVAILABLE"),
      ),
    );
  }, []);

  const refreshEvent = useCallback(async (): Promise<void> => {
    try {
      const detail = await getEvent(eventId);

      applyEventDetail(detail);
    } catch (err) {
      setError(messageFor(err));
    }
  }, [eventId, applyEventDetail]);

  useEffect(() => {
    let cancelled = false;

    setSelectedSeatIds([]);
    setActiveHold(null);
    setHoldError(null);
    setHoldNeedsLogin(false);
    setUnavailableSeatIds([]);

    async function loadEvent(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const detail = await getEvent(eventId);

        if (!cancelled) {
          setEvent(detail);
          setActiveHold(activeHoldFromEvent(detail));
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageFor(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadEvent();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  /**
   * Sprint 4 live seat map (D29/D30).
   *
   * Only authenticated viewers connect: `/ws` has no anonymous mode, so a
   * public viewer would only earn an UNAUTHORIZED close. This runs inside an
   * effect, so server rendering never opens a socket.
   *
   * Reconnect: on close, wait 1 s → 2 s → 4 s → 8 s → 15 s, then keep retrying
   * at 15 s. A plain reconnect re-authenticates with the token already stored in
   * sessionStorage; it deliberately does NOT call `/api/auth/refresh`. The
   * refresh cookie is shared by every tab of the browser profile and holds the
   * LAST login's token, so refreshing on every reconnect can silently swap this
   * tab onto another user's identity (observed: tab A reconnected while tab B
   * had logged in last and adopted B's token). Refresh is therefore reserved for
   * the one case the protocol signals: the server answers
   * `{ type: "error", code: "UNAUTHORIZED" }` before closing 1008 on a bad or
   * expired token, and the NEXT attempt refreshes once. A null refresh keeps
   * `requestJson`'s logout semantics: clear the stored token and stop. At most
   * one attempt runs at a time; a close during an in-flight refresh schedules a
   * single follow-up instead of running concurrently.
   *
   * Identity guard: the hook captures the `sub` of the token this page rendered
   * with. After a refresh, a different `sub` is never adopted silently: the tab
   * stores the fresh token and reloads, so the page renders that identity's data
   * consistently. A sessionStorage flag allows one such reload per tab; it is
   * cleared by `subscribed` (auth succeeded), and when it is already set an
   * identity change stops the loop with a warning instead of reloading again.
   *
   * Known limitation (Sprint 1 cookie design): tabs of DIFFERENT users share one
   * cookie jar, so a reconnect after a real access-token expiry can only
   * re-authenticate as the LAST login. The identity guard turns that silent
   * switch into an explicit reload. This is the shipped behavior spec §331 now
   * describes: re-authenticate with the stored token, refresh only when the
   * server rejects it, and never change identity silently.
   */
  useEffect(() => {
    const initialToken = getAccessToken();

    if (initialToken === null) {
      return;
    }

    /** The identity this page was rendered with; a refresh must match it. */
    const initialSub = jwtSubject(initialToken);
    /**
     * Non-null alias: TypeScript does not keep the guard's narrowing inside the
     * nested reconnect functions, and the reload-failure path restores this
     * exact token.
     */
    const renderedToken = initialToken;
    /**
     * A previous identity reload already re-rendered this tab. The page must
     * still connect with the stored token (a valid token clears the flag via
     * `subscribed`; an invalid one is the terminal case below).
     */
    let identityReloaded = window.sessionStorage.getItem(IDENTITY_RELOAD_FLAG) === "1";

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    /**
     * `reconnect()` can await `/auth/refresh`, so a close (or a second schedule)
     * may arrive mid-attempt. This flag guarantees at most one attempt runs;
     * `reconnectPending` remembers a close that must become a follow-up attempt.
     */
    let reconnectInFlight = false;
    let reconnectPending = false;
    let attempt = 0;
    let connectionGeneration = 0;
    /**
     * The server answered UNAUTHORIZED, so the NEXT reconnect attempt may
     * refresh. Consumed once per attempt; a plain reconnect never refreshes.
     */
    let authRejected = false;

    // A different event (effect re-run) must never inherit another map.
    seatVersionsRef.current.clear();

    function send(payload: unknown): void {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    }

    function applyLiveSeats(updates: LiveSeatUpdate[]): void {
      const filter = applySeatVersionFilter(seatVersionsRef.current, updates);

      if (filter.accepted.length === 0) {
        return;
      }

      const acceptedIds = new Set(filter.accepted);
      const accepted = updates.filter((update) => acceptedIds.has(update.id));

      // The filter has already advanced the map for accepted ids; the snapshot
      // merge is the shared, documented way to fold versions into it.
      mergeSeatSnapshot(seatVersionsRef.current, accepted);

      const acceptedById = new Map(accepted.map((update) => [update.id, update]));

      setEvent((current) => {
        if (current === null) {
          return current;
        }

        // Updating the seat status is enough: the grid's existing render
        // branches (AVAILABLE clickable, HELD/BOOKED disabled, heldByMe blue)
        // re-colour from this state, so live and initial renders cannot diverge.
        return {
          ...current,
          seats: current.seats.map((seat) => {
            const update = acceptedById.get(seat.id);

            return update === undefined
              ? seat
              : { ...seat, status: update.status, version: update.version };
          }),
        };
      });

      const takenFromSelection = new Set(
        accepted
          .filter((update) => update.status !== "AVAILABLE")
          .map((update) => update.id)
          .filter(
            (id) =>
              selectedSeatIdsRef.current.includes(id) &&
              !holdInFlightSeatIdsRef.current.includes(id),
          ),
      );

      if (takenFromSelection.size === 0) {
        return;
      }

      // D30: a selected seat that someone else just held/booked is dropped. The
      // update only removes ids, so the local MAX_SEATS_PER_HOLD=6 cap stays
      // satisfied; the toast tells the viewer why their selection shrank.
      setSelectedSeatIds((current) =>
        current.filter((id) => !takenFromSelection.has(id)),
      );
      setSeatTakenToast((count) => count + 1);
    }

    async function resyncSnapshot(): Promise<void> {
      try {
        const detail = await getEvent(eventId);

        if (stopped) {
          return;
        }

        // D29: the snapshot is truth after every (re)connect. Clear the map so
        // a change missed while disconnected cannot survive as a higher version.
        seatVersionsRef.current.clear();
        mergeSeatSnapshot(seatVersionsRef.current, detail.seats);
        applyEventDetail(detail);
      } catch (err) {
        // Keep the socket alive: the page-level load/refresh already reports
        // REST failures, and a later reconnect snapshots again.
        console.warn("SeatSync live updates: snapshot refetch failed", err);
      }
    }

    function handleFrame(raw: string): void {
      let parsed: unknown;

      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }

      if (!isRecord(parsed)) {
        return;
      }

      if (typeof parsed.type === "string") {
        if (parsed.type === "auth_ok") {
          send({ type: "subscribe", eventId });
          return;
        }

        if (parsed.type === "subscribed") {
          if (parsed.eventId === eventId) {
            // Only a completed subscribe proves the whole chain works, so the
            // backoff resets here rather than on TCP/WS open.
            attempt = 0;
            // Auth and subscribe succeeded, so this tab has a usable identity
            // again; a later identity change may reload once more.
            identityReloaded = false;
            window.sessionStorage.removeItem(IDENTITY_RELOAD_FLAG);
            void resyncSnapshot();
          }
          return;
        }

        if (parsed.type === "error") {
          const code = typeof parsed.code === "string" ? parsed.code : "UNKNOWN";
          const message =
            typeof parsed.message === "string" ? parsed.message : "unknown error";

          if (code === "UNAUTHORIZED") {
            // The server sends this before close 1008 when the token is bad or
            // expired. Only this rejection earns a refresh on the next attempt;
            // the close that follows schedules it.
            authRejected = true;
          }

          console.warn(`SeatSync live updates: server error ${code}: ${message}`);
          return;
        }

        return;
      }

      // Seat frames are broadcast verbatim by the Redis subscriber and therefore
      // carry no `type`: `{ eventId, seats: [{ id, status, version }] }`.
      if (isLiveSeatFrame(parsed) && parsed.eventId === eventId) {
        applyLiveSeats(parsed.seats);
      }
    }

    function connect(token: string): void {
      if (stopped) {
        return;
      }

      let ws: WebSocket;

      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        // A malformed NEXT_PUBLIC_WS_URL must not break the page; live updates
        // stay off until the configuration is fixed and the page reloads.
        console.warn("SeatSync live updates: invalid WebSocket URL", err);
        return;
      }

      socket = ws;
      const generation = ++connectionGeneration;

      ws.onopen = () => {
        if (stopped || generation !== connectionGeneration) {
          return;
        }

        ws.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onmessage = (message) => {
        if (stopped || generation !== connectionGeneration) {
          return;
        }

        if (typeof message.data === "string") {
          handleFrame(message.data);
        }
      };

      ws.onerror = () => {
        // Deliberately quiet: the browser's opaque error event is always
        // followed by close, and `onclose` owns the single reconnect/log path so
        // a dead server cannot flood the console.
      };

      ws.onclose = () => {
        if (generation !== connectionGeneration) {
          return;
        }

        socket = null;

        if (!stopped) {
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect(): void {
      if (stopped || reconnectTimer !== null) {
        return;
      }

      if (reconnectInFlight) {
        // A close landed while an attempt was awaiting a refresh. Never run two
        // attempts at once: run exactly one follow-up after the current one.
        reconnectPending = true;
        return;
      }

      const delay = Math.min(
        WS_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 4),
        WS_RECONNECT_MAX_DELAY_MS,
      );

      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void runReconnect();
      }, delay);
    }

    async function runReconnect(): Promise<void> {
      reconnectInFlight = true;

      try {
        await reconnect();
      } catch (err) {
        // A storage failure (or any unexpected throw) must surface as a warning
        // rather than an unhandled rejection. The loop stops here; a reload can
        // start it again.
        console.warn("SeatSync live updates: reconnect attempt failed", err);
      } finally {
        reconnectInFlight = false;

        // A follow-up only makes sense if the attempt left no live socket and
        // did not deliberately stop the loop (terminal auth failure/reload).
        if (reconnectPending) {
          reconnectPending = false;

          if (!stopped && socket === null) {
            scheduleReconnect();
          }
        }
      }
    }

    async function reconnect(): Promise<void> {
      if (stopped) {
        return;
      }

      if (!authRejected) {
        // Plain reconnect: reuse the token this tab already holds. Refreshing
        // here would authenticate as whichever user logged in last in this
        // browser profile and silently change this tab's identity.
        const storedToken = getAccessToken();

        if (storedToken === null) {
          // No token anywhere: no later attempt can authenticate.
          console.warn("SeatSync live updates: no stored token; reconnect stopped");
          stopped = true;
          return;
        }

        connect(storedToken);
        return;
      }

      // Consume the rejection before awaiting: one refresh per auth attempt,
      // even if the connection drops while the refresh is in flight.
      authRejected = false;

      const token = await refreshAccessToken();

      if (stopped) {
        return;
      }

      if (token === null) {
        // Logged out or the refresh cookie expired: no later attempt can
        // authenticate. Mirror `requestJson`'s 401 path and stop.
        clearAccessToken();
        console.warn("SeatSync live updates: session expired; reconnect stopped");
        stopped = true;
        return;
      }

      const refreshedSub = jwtSubject(token);

      if (refreshedSub !== initialSub) {
        // The shared cookie now belongs to another user. Never adopt that
        // identity silently: this tab's UI was rendered from `initialSub`'s
        // data, so a hold or release sent with the new token would act as
        // someone else. Reload instead, so the page renders the new user's
        // data consistently from the stored token.
        console.warn("SeatSync live updates: token refresh changed identity; reloading the page");

        if (identityReloaded) {
          // The reload after the previous identity change still cannot hold a
          // session. Reloading again would loop, so stop and leave the warning.
          console.warn("SeatSync live updates: identity already reloaded once; reconnect stopped");
          stopped = true;
          return;
        }

        // The reloaded page reads this token from sessionStorage. If storage or
        // navigation is unavailable, do not adopt the foreign identity: log,
        // restore the token this page was rendered with, clear the marker and
        // stop the loop. A partial switch would leave the UI showing one user
        // while REST calls act as another.
        try {
          setAccessToken(token);
          window.sessionStorage.setItem(IDENTITY_RELOAD_FLAG, "1");
          window.location.reload();
        } catch (err) {
          console.warn(
            "SeatSync live updates: identity reload failed; reconnect stopped",
            err,
          );

          try {
            setAccessToken(renderedToken);
          } catch {
            // The page keeps whatever token is stored; it stops either way.
          }

          try {
            // Leaving this marker behind would make a later page load stop
            // instead of retrying the identity reload.
            window.sessionStorage.removeItem(IDENTITY_RELOAD_FLAG);
          } catch {
            // Storage is what just failed; there is nothing else to clean up.
          }

          stopped = true;
        }
        return;
      }

      // Persist before connecting: the subscribe snapshot's REST call reads it.
      setAccessToken(token);
      connect(token);
    }

    connect(initialToken);

    return () => {
      stopped = true;
      connectionGeneration += 1;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const dying = socket;
      socket = null;

      if (dying !== null) {
        // Detach first so a deliberate close cannot schedule a reconnect.
        dying.onopen = null;
        dying.onmessage = null;
        dying.onerror = null;
        dying.onclose = null;

        try {
          dying.close();
        } catch {
          // Closing a still-connecting socket can throw in some browsers; the
          // handlers are already detached, so there is nothing left to clean.
        }
      }
    };
  }, [eventId, applyEventDetail]);

  // One shared ticker keeps the countdown and the per-seat tooltips live.
  useEffect(() => {
    if (activeHold === null) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [activeHold]);

  const remainingMs = activeHold === null ? 0 : Date.parse(activeHold.heldUntil) - now;
  const holdExpired = activeHold !== null && remainingMs <= 0;
  const countdown = activeHold === null ? null : formatCountdown(remainingMs);

  // Display-only expiry: D9 already makes the expired seats read AVAILABLE, so
  // refreshing the detail is enough — no auto-release call is sent.
  useEffect(() => {
    if (!holdExpired) {
      return;
    }

    void refreshEvent();
  }, [holdExpired, refreshEvent]);

  const sections = event === null ? [] : groupSeatsBySection(event.seats);

  function labelForSeatId(seatId: string): string {
    const seat = event?.seats.find((candidate) => candidate.id === seatId);

    return seat === undefined ? seatId : seatLabel(seat);
  }

  function toggleSeat(seatId: string): void {
    setSelectedSeatIds((current) => {
      if (current.includes(seatId)) {
        return current.filter((id) => id !== seatId);
      }

      if (current.length >= MAX_SEATS_PER_HOLD) {
        return current;
      }

      return [...current, seatId];
    });
  }

  async function handleHold(): Promise<void> {
    if (selectedSeatIds.length === 0 || submitting) {
      return;
    }

    if (getAccessToken() === null) {
      // Anonymous visitors may browse and select, but a hold belongs to an
      // account. Keep the selection so the user only has to press Hold again
      // after logging in (the selection itself does not survive the navigation).
      setHoldNeedsLogin(true);
      setHoldError(
        "Log in to hold seats — holding locks a seat for 10 minutes under your account.",
      );
      setUnavailableSeatIds([]);
      return;
    }

    setHoldNeedsLogin(false);
    setSubmitting(true);
    setHoldError(null);
    setUnavailableSeatIds([]);

    // The API emits HELD frames for this request's own seats after COMMIT. Guard
    // them so the live handler cannot mistake our successful hold for someone
    // else taking the seats (the 201 path clears the selection itself).
    holdInFlightSeatIdsRef.current = selectedSeatIds;

    try {
      // D2: a fresh key per click; never reuse a key for a different attempt.
      const result = await createHold(eventId, selectedSeatIds, crypto.randomUUID());

      if (result.status === 201) {
        setActiveHold({
          holdId: result.body.holdId,
          seatIds: result.body.seatIds,
          heldUntil: result.body.heldUntil,
        });
        setSelectedSeatIds([]);
        await refreshEvent();
      } else {
        setUnavailableSeatIds(unavailableSeatIdsFrom(result.body));
        setHoldError(result.body.error.message);
        await refreshEvent();
      }
    } catch (err) {
      // 422/400/404 and other errors carry the API envelope message.
      setHoldError(messageFor(err));
    } finally {
      holdInFlightSeatIdsRef.current = [];
      setSubmitting(false);
    }
  }

  async function handleRelease(): Promise<void> {
    if (activeHold === null || releasing) {
      return;
    }

    setReleasing(true);
    setHoldError(null);
    setHoldNeedsLogin(false);
    setUnavailableSeatIds([]);

    try {
      await releaseHold(activeHold.holdId);
      setActiveHold(null);
      await refreshEvent();
    } catch (err) {
      setHoldError(messageFor(err));
      await refreshEvent();
    } finally {
      setReleasing(false);
    }
  }

  async function handlePay(): Promise<void> {
    if (activeHold === null || paying || holdExpired) {
      return;
    }

    setPaying(true);
    setHoldError(null);
    setHoldNeedsLogin(false);
    setUnavailableSeatIds([]);

    try {
      const checkout = await createCheckout(activeHold.holdId);

      // Fake URLs are same-origin paths; Razorpay's are absolute. Both work
      // with a full navigation.
      window.location.href = checkout.checkoutUrl;
    } catch (err) {
      setHoldError(messageFor(err));
      setPaying(false);
    }
  }

  const unavailableLabels = unavailableSeatIds.map(labelForSeatId);

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <header className="space-y-2">
        <Link href="/events" className="text-sm text-slate-500 underline">
          ← Back to events
        </Link>

        {event !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${EVENT_STATUS_STYLES[event.status]}`}
            >
              {event.status}
            </span>
          </div>
        ) : (
          <h1 className="text-3xl font-bold tracking-tight">Event details</h1>
        )}

        {event !== null ? (
          <p className="text-slate-600">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
        ) : null}
      </header>

      {loading && event === null ? <p className="text-slate-600">Loading event…</p> : null}

      {error !== null ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {event !== null ? (
        <>
          {holdError !== null ? (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                unavailableLabels.length > 0
                  ? "bg-amber-50 text-amber-800"
                  : "bg-red-50 text-red-700"
              }`}
            >
              <p>
                {holdNeedsLogin ? (
                  <Link href="/login" className="font-medium underline">
                    {holdError}
                  </Link>
                ) : (
                  holdError
                )}
              </p>
              {unavailableLabels.length > 0 ? (
                <p className="mt-1 font-medium">
                  No longer available: {unavailableLabels.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {activeHold !== null ? (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <div className="space-y-1">
                <p className="font-semibold text-blue-900">
                  {holdExpired ? "Hold expired" : `Your hold · ${countdown ?? "00:00"}`}
                </p>
                <p className="text-sm text-blue-800">
                  {activeHold.seatIds.length} seat
                  {activeHold.seatIds.length === 1 ? "" : "s"} ·{" "}
                  {activeHold.seatIds.map(labelForSeatId).join(", ")}
                </p>
                <p className="text-xs text-blue-700">
                  Expires {formatDateTime(activeHold.heldUntil)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePay()}
                  disabled={paying || holdExpired}
                  className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {paying ? "Starting checkout…" : "Pay"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRelease()}
                  disabled={releasing}
                  className="rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-900 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {releasing ? "Releasing…" : "Release hold"}
                </button>
              </div>
            </section>
          ) : null}

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
            <span className="font-medium text-slate-700">Seat status</span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-green-300 bg-green-100" />
              AVAILABLE
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-amber-300 bg-amber-100" />
              HELD
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-red-300 bg-red-100" />
              BOOKED
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-slate-900 bg-slate-900" />
              SELECTED
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-blue-400 bg-blue-100" />
              YOUR HOLD
            </span>
          </div>

          {event.status === "PUBLISHED" ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Hold seats</h2>
                  <p className="text-sm text-slate-600">
                    {selectedSeatIds.length} of {MAX_SEATS_PER_HOLD} selected
                    {selectedSeatIds.length === MAX_SEATS_PER_HOLD
                      ? " · maximum reached"
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleHold()}
                  disabled={
                    selectedSeatIds.length === 0 || submitting || activeHold !== null
                  }
                  className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Holding…" : "Hold selected seats"}
                </button>
              </div>
              {activeHold !== null ? (
                <p className="text-xs text-slate-500">
                  Release your current hold before holding other seats.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Publish this event before holding seats.
            </p>
          )}

          {sections.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-600">
              This event has no seats yet.
            </p>
          ) : (
            <div className="space-y-6">
              {sections.map((section) => (
                <section
                  key={section.name}
                  className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-xl font-semibold">{section.name}</h2>
                    <p className="text-sm text-slate-600">
                      {formatPaise(section.pricePaise)} per seat
                    </p>
                  </header>

                  <div className="space-y-2 overflow-x-auto">
                    {section.rows.map((row) => (
                      <div key={row.rowLabel} className="flex items-center gap-3">
                        <span className="w-8 shrink-0 text-xs font-medium text-slate-500">
                          {row.rowLabel}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {row.seats.map((seat) => {
                            const isSelected = selectedSeatIds.includes(seat.id);
                            const isMine = seat.heldByMe === true;

                            if (seat.status === "AVAILABLE") {
                              return (
                                <button
                                  key={seat.id}
                                  type="button"
                                  aria-pressed={isSelected}
                                  title={`Row ${row.rowLabel} seat ${seat.number}: ${
                                    isSelected ? "selected" : "available"
                                  }`}
                                  onClick={() => toggleSeat(seat.id)}
                                  className={`flex h-7 w-7 items-center justify-center rounded border text-[10px] font-medium transition ${
                                    isSelected
                                      ? SELECTED_SEAT_STYLE
                                      : SEAT_STATUS_STYLES.AVAILABLE
                                  }`}
                                >
                                  {seat.number}
                                </button>
                              );
                            }

                            return (
                              <button
                                key={seat.id}
                                type="button"
                                disabled
                                title={`Row ${row.rowLabel} seat ${seat.number}: ${
                                  isMine
                                    ? `your hold${countdown === null ? "" : `, ${countdown} left`}`
                                    : seat.status
                                }`}
                                className={`flex h-7 w-7 cursor-not-allowed items-center justify-center rounded border text-[10px] font-medium ${
                                  isMine
                                    ? MY_HOLD_SEAT_STYLE
                                    : SEAT_STATUS_STYLES[seat.status]
                                }`}
                              >
                                {seat.number}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      ) : null}

      {/* D30: fixed, self-dismissing notice; no dependency and no portal. */}
      {seatTakenToast > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg"
        >
          {SEAT_TAKEN_MESSAGE}
        </div>
      ) : null}
    </main>
  );
}
