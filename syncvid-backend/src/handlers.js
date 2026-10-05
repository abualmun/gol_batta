/**
 * Socket.io event handlers — one call per connection.
 * The wire format is documented in /PROTOCOL.md; keep the two in step.
 */

import { createRateLimiter } from "./rateLimit.js";
import { publicMember } from "./rooms.js";
import * as v from "./validate.js";

const RATE_NOTICE_INTERVAL_MS = 2000;

export function registerHandlers(io, socket, store, log) {
  const allow = createRateLimiter();
  /** Set only after a successful join — a socket that got "room full" has no room. */
  let roomId = null;
  let lastRateNotice = 0;

  function currentRoom() {
    return roomId ? store.get(roomId) : null;
  }

  function currentMember() {
    return currentRoom()?.members.get(socket.id) ?? null;
  }

  function sendError(code, message) {
    socket.emit("room:error", { code, message });
  }

  /** Wrap a handler with rate limiting, payload normalisation and error isolation. */
  function on(event, handler) {
    socket.on(event, (...args) => {
      const ack = typeof args.at(-1) === "function" ? args.pop() : null;
      const payload = v.isPlainObject(args[0]) ? args[0] : {};

      if (!allow(event)) {
        const t = Date.now();
        if (t - lastRateNotice > RATE_NOTICE_INTERVAL_MS) {
          lastRateNotice = t;
          sendError("rate_limited", "You're doing that too fast. Please slow down.");
        }
        ack?.({ ok: false, error: "rate_limited" });
        return;
      }
      try {
        handler(payload, ack);
      } catch (err) {
        log(`[Error] ${event} from ${socket.id}: ${err?.stack || err}`);
      }
    });
  }

  function leaveCurrentRoom() {
    if (!roomId) return;
    const id = roomId;
    roomId = null;
    socket.leave(id);
    const result = store.leave(id, socket.id);
    if (result && !result.deleted) {
      socket.to(id).emit("room:peer_left", { peerId: result.member.id });
    }
    if (result) log(`[Room ${id}] left (${result.deleted ? "room closed" : "1 remaining"})`);
  }

  // ─── Clock sync ────────────────────────────────────────────────────────────
  on("time:ping", (_payload, ack) => {
    ack?.({ serverTime: Date.now() });
  });

  // ─── Join / leave ──────────────────────────────────────────────────────────
  on("room:join", (payload) => {
    const id = v.roomId(payload.roomId);
    if (!id) return sendError("invalid_room", "That room link or code isn't valid.");
    const name = v.name(payload.name);
    if (!name) return sendError("invalid_name", "Please enter a name (1–24 characters).");
    const clientId = v.clientId(payload.clientId);

    if (roomId && roomId !== id) leaveCurrentRoom();

    const result = store.join(id, { socketId: socket.id, clientId, name });
    if (!result.ok) {
      if (result.reason === "full") {
        socket.emit("room:full", { message: "This room already has 2 people in it." });
      } else {
        sendError("server_busy", "The server is busy right now. Please try again in a minute.");
      }
      return;
    }

    if (result.evicted) {
      // A stale connection of the same browser tab: close it quietly.
      const stale = io.sockets.sockets.get(result.evicted.socketId);
      if (stale) {
        stale.emit("room:error", {
          code: "replaced",
          message: "This room was opened in another window.",
        });
        stale.disconnect(true);
      }
    }

    roomId = id;
    socket.join(id);
    const { room, member, peer } = result;

    socket.emit("room:joined", {
      roomId: id,
      you: publicMember(member),
      peer: peer ? publicMember(peer) : null,
      state: room.state,
      chat: room.chat,
    });
    socket.to(id).emit("room:peer_joined", { peer: publicMember(member) });
    log(`[Room ${id}] joined (${room.members.size}/2)${result.evicted ? " — replaced stale connection" : ""}`);
  });

  on("room:leave", (_payload, ack) => {
    leaveCurrentRoom();
    ack?.({ ok: true });
  });

  // ─── Video ─────────────────────────────────────────────────────────────────
  on("video:hash", (payload) => {
    const room = currentRoom();
    if (!room?.members.has(socket.id)) return;
    const hash = v.hash(payload.hash);
    const duration = v.duration(payload.duration);
    if (!hash || duration === undefined) return;

    const results = store.setFile(room, socket.id, {
      hash,
      fileName: v.fileName(payload.fileName),
      duration,
    });
    if (results) {
      for (const [socketId, result] of results) io.to(socketId).emit("video:hash_result", result);
      log(`[Room ${room.id}] files ${[...results.values()][0].match ? "match" : "DIFFER"}`);
    }
  });

  on("video:control", (payload) => {
    const room = currentRoom();
    const member = currentMember();
    if (!member) return;
    const action = v.action(payload.action);
    const position = v.position(payload.position);
    if (!action || position === null) return;

    const state = store.applyControl(room, member, { action, position });
    io.to(room.id).emit("video:state", state);
  });

  on("video:report", (payload) => {
    if (!currentMember()) return;
    const position = v.position(payload.position);
    if (position === null || typeof payload.playing !== "boolean") return;
    const now = Date.now();
    socket.to(roomId).emit("video:peer_report", {
      position,
      playing: payload.playing,
      at: v.serverTimestamp(payload.at, now) ?? now,
      seq: Number.isSafeInteger(payload.seq) ? payload.seq : null,
    });
  });

  // ─── Chat ──────────────────────────────────────────────────────────────────
  on("chat:send", (payload, ack) => {
    const room = currentRoom();
    const member = currentMember();
    if (!member) return ack?.({ ok: false, error: "not_in_room" });
    const text = v.chatText(payload.text);
    if (!text) return ack?.({ ok: false, error: "invalid_text" });

    const message = store.addChat(room, member, text);
    io.to(room.id).emit("chat:message", message);
    ack?.({ ok: true, id: message.id });
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    leaveCurrentRoom();
  });
}
