/**
 * In-memory room store. Pure logic, no sockets — every rule about rooms lives here
 * so it can be unit-tested directly.
 *
 * Room shape:
 *   {
 *     id,
 *     members: Map<socketId, { id, name, clientId, socketId }>,   // id = public id shown to peers
 *     files:   Map<socketId, { hash, fileName, duration }>,
 *     state:   null | { playing, position, updatedAt, seq, action, by: { id, name } },
 *     seq,     // last state sequence number
 *     chat:    [{ id, from: { id, name }, text, at }],
 *   }
 */

import { randomBytes } from "node:crypto";

const defaultNewId = () => randomBytes(9).toString("base64url");

export function publicMember(member) {
  return { id: member.id, name: member.name };
}

export function createRoomStore({
  maxRooms,
  maxMembers,
  chatHistorySize,
  now = Date.now,
  newId = defaultNewId,
}) {
  const rooms = new Map();

  function get(roomId) {
    return rooms.get(roomId) ?? null;
  }

  /**
   * Add a socket to a room.
   * If a member with the same clientId is already there (a reconnecting tab whose old
   * socket has not timed out yet), that stale member is replaced and returned as `evicted`.
   *
   * @returns {{ ok: true, room, member, peer, evicted } | { ok: false, reason: "full" | "capacity" }}
   */
  function join(roomId, { socketId, clientId, name }) {
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= maxRooms) return { ok: false, reason: "capacity" };
      room = { id: roomId, members: new Map(), files: new Map(), state: null, seq: 0, chat: [] };
      rooms.set(roomId, room);
    }

    // Same socket joining again (e.g. after a name change): just update the name.
    const existing = room.members.get(socketId);
    if (existing) {
      existing.name = name;
      return { ok: true, room, member: existing, peer: peerOf(room, socketId), evicted: null };
    }

    let evicted = null;
    if (clientId) {
      for (const m of room.members.values()) {
        if (m.clientId === clientId) {
          evicted = m;
          removeMember(room, m.socketId);
          break;
        }
      }
    }

    if (room.members.size >= maxMembers) return { ok: false, reason: "full" };

    const member = { id: newId(), name, clientId, socketId };
    room.members.set(socketId, member);
    return { ok: true, room, member, peer: peerOf(room, socketId), evicted };
  }

  function removeMember(room, socketId) {
    room.members.delete(socketId);
    room.files.delete(socketId);
  }

  /**
   * Remove a socket from a room. Empty rooms are deleted.
   * @returns {{ room, member, deleted: boolean } | null}
   */
  function leave(roomId, socketId) {
    const room = rooms.get(roomId);
    const member = room?.members.get(socketId);
    if (!member) return null;
    removeMember(room, socketId);
    const deleted = room.members.size === 0;
    if (deleted) rooms.delete(roomId);
    return { room, member, deleted };
  }

  /** The other member of the room, or null. */
  function peerOf(room, socketId) {
    for (const m of room.members.values()) if (m.socketId !== socketId) return m;
    return null;
  }

  /** Apply a play/pause/seek request from a member. Returns the new room state. */
  function applyControl(room, member, { action, position }) {
    const playing =
      action === "play" ? true : action === "pause" ? false : (room.state?.playing ?? false);
    room.seq += 1;
    room.state = {
      playing,
      position,
      updatedAt: now(),
      seq: room.seq,
      action,
      by: publicMember(member),
    };
    return room.state;
  }

  /**
   * Record a member's file fingerprint. When both members have one, returns a
   * Map<socketId, { match, yourFile, peerFile }>; otherwise null.
   */
  function setFile(room, socketId, file) {
    room.files.set(socketId, file);
    return compareFiles(room);
  }

  function compareFiles(room) {
    if (room.files.size < 2) return null;
    const [[idA, a], [idB, b]] = [...room.files.entries()];
    const match = a.hash === b.hash;
    const describe = ({ fileName, duration }) => ({ fileName, duration });
    return new Map([
      [idA, { match, yourFile: describe(a), peerFile: describe(b) }],
      [idB, { match, yourFile: describe(b), peerFile: describe(a) }],
    ]);
  }

  /** Append a chat message (keeps only the most recent `chatHistorySize`). */
  function addChat(room, member, text) {
    const message = { id: newId(), from: publicMember(member), text, at: now() };
    room.chat.push(message);
    if (room.chat.length > chatHistorySize) room.chat.splice(0, room.chat.length - chatHistorySize);
    return message;
  }

  return {
    get,
    join,
    leave,
    peerOf,
    applyControl,
    setFile,
    addChat,
    get size() {
      return rooms.size;
    },
  };
}
