import type { UserRole } from "@seatsync/shared";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Logger } from "pino";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { z } from "zod";
import type { Config } from "../config";
import { logger } from "../logger";
import { verifyAccessToken } from "../middleware/auth";

/**
 * Sprint 4 realtime seat map — `/ws` server (D28).
 *
 * Protocol (all frames are JSON text):
 *   1. The client's first message must be `{ "type": "auth", "token": "<jwt>" }`.
 *      Success acknowledges `{ "type": "auth_ok" }`. An invalid/expired token,
 *      unparseable JSON, or any non-auth first message is answered with
 *      `{ "type": "error", "code": "UNAUTHORIZED", "message": "..." }` and the
 *      socket is closed with code 1008. There is no anonymous mode.
 *   2. `{ "type": "subscribe", "eventId": "<uuid>" }` joins the event's room and
 *      acknowledges `{ "type": "subscribed", "eventId": "<uuid>" }`. A socket
 *      may subscribe to several events. A malformed subscribe (non-UUID id) is
 *      a protocol violation: `BAD_MESSAGE` then close 1008.
 *   3. Unknown message shapes after authentication get `{ "type": "error",
 *      "code": "BAD_MESSAGE", "message": "..." }` but do not close the socket:
 *      a live feed should not die because a newer client sent something this
 *      server version does not know yet.
 *
 * Step 2 forwards Redis `seats:*` messages through `hub.broadcast(eventId,
 * payload)`; the hub serialises once and writes to every subscribed socket.
 *
 * Redis is deliberately absent here: this module only owns sockets, rooms and
 * the heartbeat, so a Redis outage can never block or fail the HTTP API.
 */

const WS_PATH = "/ws";

/** Heartbeat: ping every 30 s; a socket that misses one pong is terminated. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** RFC 6455 policy violation, used for every rejected protocol message. */
const CLOSE_POLICY_VIOLATION = 1008;

const AuthMessageSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  eventId: z.string().uuid(),
});

type ErrorCode = "UNAUTHORIZED" | "BAD_MESSAGE";

type ServerMessage =
  | { type: "auth_ok" }
  | { type: "subscribed"; eventId: string }
  | { type: "error"; code: ErrorCode; message: string };

interface SocketState {
  /** Principal set by the first successful `auth` message; null until then. */
  user: { id: string; role: UserRole } | null;
  /** Heartbeat flag: true after connect/pong, false after a ping is sent. */
  isAlive: boolean;
  /** Event rooms this socket joined, so close cleanup is O(subscriptions). */
  rooms: Set<string>;
}

/**
 * Per-attachment room hub. It is created inside `attachRealtimeServer`, never
 * shared module-wide, so two API instances (or two ephemeral test servers) in
 * one process keep independent rooms.
 */
export interface RealtimeHub {
  /** Send one JSON frame to every socket subscribed to `eventId`. */
  broadcast(eventId: string, payload: unknown): void;
}

export interface RealtimeServerDeps {
  config: Config;
  /** Optional test/child logger; defaults to the process logger. */
  log?: Logger;
  /**
   * Step 2 seam: called exactly once with this attachment's hub so the Redis
   * subscriber can forward `seats:*` messages into WS rooms.
   */
  onHubReady?: (hub: RealtimeHub) => void;
}

export interface AttachedRealtimeServer {
  /** Stop accepting sockets, terminate the live ones and clear the heartbeat. */
  close(): Promise<void>;
  /** This attachment's rooms; used by the Sprint 4 subscriber. */
  hub: RealtimeHub;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

/**
 * Attach the `/ws` WebSocket server to an existing Node HTTP server.
 *
 * The HTTP server stays owned by the caller (`apps/api/src/server.ts`); this
 * function only adds the upgrade path and returns a close handle plus the hub
 * that step 2's Redis subscriber broadcasts through.
 */
export function attachRealtimeServer(
  server: HttpServer,
  deps: RealtimeServerDeps,
): AttachedRealtimeServer {
  const { config } = deps;
  const log = deps.log ?? logger;
  const wss = new WebSocketServer({ server, path: WS_PATH });

  /** eventId -> sockets; deliberately per attachment, not a module singleton. */
  const rooms = new Map<string, Set<WebSocket>>();
  /** Per-socket protocol/heartbeat state for this attachment. */
  const states = new Map<WebSocket, SocketState>();

  let closing: Promise<void> | null = null;

  function sendFrame(socket: WebSocket, frame: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(frame);
    } catch (error) {
      // A dying socket must never crash the process.
      log.warn({ err: error }, "WebSocket send failed");
    }
  }

  function sendMessage(socket: WebSocket, message: ServerMessage): void {
    let frame: string;

    try {
      frame = JSON.stringify(message);
    } catch (error) {
      log.warn({ err: error }, "WebSocket message serialisation failed");
      return;
    }

    sendFrame(socket, frame);
  }

  function closeForProtocolViolation(socket: WebSocket, reason: string): void {
    try {
      socket.close(CLOSE_POLICY_VIOLATION, reason);
    } catch {
      socket.terminate();
    }
  }

  function rejectUnauthorized(socket: WebSocket, message: string): void {
    sendMessage(socket, { type: "error", code: "UNAUTHORIZED", message });
    closeForProtocolViolation(socket, "unauthorized");
  }

  function badMessage(socket: WebSocket, message: string): void {
    // Post-auth protocol noise is logged and answered, not fatal: keeping the
    // socket alive preserves live updates when a client is merely misbehaving.
    log.debug({ message }, "WebSocket BAD_MESSAGE");
    sendMessage(socket, { type: "error", code: "BAD_MESSAGE", message });
  }

  function joinRoom(socket: WebSocket, state: SocketState, eventId: string): void {
    let room = rooms.get(eventId);

    if (room === undefined) {
      room = new Set<WebSocket>();
      rooms.set(eventId, room);
    }

    room.add(socket);
    state.rooms.add(eventId);
  }

  function leaveRooms(socket: WebSocket, state: SocketState): void {
    for (const eventId of state.rooms) {
      const room = rooms.get(eventId);

      if (room === undefined) {
        continue;
      }

      room.delete(socket);

      if (room.size === 0) {
        rooms.delete(eventId);
      }
    }

    state.rooms.clear();
  }

  function handleMessage(socket: WebSocket, state: SocketState, data: RawData): void {
    const parsed = parseJson(rawDataToString(data));

    if (state.user === null) {
      const auth = AuthMessageSchema.safeParse(parsed);

      if (!auth.success) {
        // D28: the first message must authenticate; never fall back to
        // anonymous access (unlike `optionalAuth` on HTTP routes).
        rejectUnauthorized(socket, "Authentication required: send { type: \"auth\", token } first");
        return;
      }

      let user: { id: string; role: UserRole };

      try {
        user = verifyAccessToken(auth.data.token, config);
      } catch {
        rejectUnauthorized(socket, "Invalid or expired access token");
        return;
      }

      state.user = user;
      sendMessage(socket, { type: "auth_ok" });
      log.debug({ userId: user.id, role: user.role }, "WebSocket authenticated");
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      badMessage(socket, "Expected a JSON object with a type");
      return;
    }

    if (parsed.type === "subscribe") {
      const subscribe = SubscribeMessageSchema.safeParse(parsed);

      if (!subscribe.success) {
        sendMessage(socket, {
          type: "error",
          code: "BAD_MESSAGE",
          message: "subscribe requires a UUID eventId",
        });
        closeForProtocolViolation(socket, "invalid subscribe");
        return;
      }

      joinRoom(socket, state, subscribe.data.eventId);
      sendMessage(socket, { type: "subscribed", eventId: subscribe.data.eventId });
      return;
    }

    if (parsed.type === "auth") {
      badMessage(socket, "Already authenticated");
      return;
    }

    badMessage(socket, `Unknown message type: ${parsed.type}`);
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const state: SocketState = { user: null, isAlive: true, rooms: new Set<string>() };
    states.set(socket, state);
    log.debug({ remoteAddress: request.socket.remoteAddress }, "WebSocket connected");

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (data) => {
      try {
        handleMessage(socket, state, data);
      } catch (error) {
        // Guard the event handler itself: no protocol bug may take down the
        // HTTP process that shares this server.
        log.error({ err: error }, "WebSocket message handler failed");
        sendMessage(socket, {
          type: "error",
          code: "BAD_MESSAGE",
          message: "Malformed message",
        });
      }
    });

    socket.on("error", (error) => {
      log.warn({ err: error }, "WebSocket error");
    });

    socket.on("close", (code: number) => {
      leaveRooms(socket, state);
      states.delete(socket);
      log.debug({ code, userId: state.user?.id ?? null }, "WebSocket closed");
    });
  });

  wss.on("error", (error) => {
    log.warn({ err: error }, "WebSocket server error");
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);

      if (state === undefined) {
        continue;
      }

      if (!state.isAlive) {
        log.warn({ userId: state.user?.id ?? null }, "WebSocket heartbeat missed; terminating");
        try {
          socket.terminate();
        } catch (error) {
          log.warn({ err: error }, "WebSocket terminate failed");
        }
        continue;
      }

      state.isAlive = false;

      try {
        socket.ping();
      } catch (error) {
        log.warn({ err: error }, "WebSocket ping failed");
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const hub: RealtimeHub = {
    broadcast(eventId: string, payload: unknown): void {
      const room = rooms.get(eventId);

      if (room === undefined || room.size === 0) {
        return;
      }

      let frame: string;

      try {
        frame = JSON.stringify(payload);
      } catch (error) {
        log.warn({ err: error }, "WebSocket broadcast serialisation failed");
        return;
      }

      for (const socket of room) {
        sendFrame(socket, frame);
      }
    },
  };

  deps.onHubReady?.(hub);

  function close(): Promise<void> {
    if (closing !== null) {
      return closing;
    }

    clearInterval(heartbeat);

    closing = new Promise<void>((resolve) => {
      // wss.close() stops the upgrade listener first and then waits for the
      // live sockets; terminate them so shutdown cannot hang on a dead peer.
      wss.close(() => {
        resolve();
      });

      for (const socket of wss.clients) {
        try {
          socket.terminate();
        } catch (error) {
          log.warn({ err: error }, "WebSocket shutdown terminate failed");
        }
      }

      rooms.clear();
      states.clear();
    });

    return closing;
  }

  return { close, hub };
}
