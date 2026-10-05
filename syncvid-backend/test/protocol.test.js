/**
 * Integration tests: a real server on a random port, real Socket.io clients.
 * These pin down the wire protocol documented in /PROTOCOL.md.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { io as connectClient } from "socket.io-client";
import { createSyncVidServer } from "../src/app.js";

const baseConfig = {
  allowedOrigins: [],
  maxMembersPerRoom: 2,
  maxRooms: 100,
  chatHistorySize: 50,
  maxPayloadBytes: 16 * 1024,
};

async function startServer(overrides = {}) {
  const server = createSyncVidServer({ ...baseConfig, ...overrides }, { log: () => {} });
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = server.httpServer.address();
  return { ...server, url: `http://127.0.0.1:${port}` };
}

const clients = new Set();

function connect(url, options = {}) {
  const socket = connectClient(url, { transports: ["websocket"], forceNew: true, reconnection: false, ...options });
  clients.add(socket);
  return socket;
}

function once(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Resolves true if `event` does NOT arrive within `ms`. */
function never(socket, event, ms = 300) {
  return new Promise((resolve, reject) => {
    const handler = (data) => reject(new Error(`unexpected "${event}": ${JSON.stringify(data)}`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, ms);
  });
}

let roomCounter = 0;
const newRoomId = () => `test-room-${++roomCounter}`;

async function join(url, roomId, name, extra = {}) {
  const socket = connect(url);
  await once(socket, "connect");
  const joined = once(socket, "room:joined");
  socket.emit("room:join", { roomId, name, ...extra });
  return { socket, joined: await joined };
}

describe("protocol", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    for (const c of clients) c.disconnect();
    await new Promise((resolve) => srv.io.close(resolve));
  });

  it("answers time:ping with the server time", async () => {
    const socket = connect(srv.url);
    const before = Date.now();
    const reply = await socket.timeout(2000).emitWithAck("time:ping", {});
    assert.ok(reply.serverTime >= before && reply.serverTime <= Date.now());
  });

  it("joins two people and tells each about the other", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    assert.equal(a.joined.roomId, roomId);
    assert.equal(a.joined.you.name, "Alice");
    assert.equal(typeof a.joined.you.id, "string");
    assert.equal(a.joined.peer, null);
    assert.equal(a.joined.state, null);
    assert.deepEqual(a.joined.chat, []);

    const peerJoined = once(a.socket, "room:peer_joined");
    const b = await join(srv.url, roomId.toUpperCase(), "Bob");
    assert.equal(b.joined.roomId, roomId, "room ids are case-insensitive");
    assert.deepEqual(b.joined.peer, a.joined.you);
    assert.deepEqual((await peerJoined).peer, b.joined.you);
  });

  it("rejects bad room ids and names", async () => {
    const socket = connect(srv.url);
    await once(socket, "connect");
    socket.emit("room:join", { roomId: "x", name: "Alice" });
    assert.equal((await once(socket, "room:error")).code, "invalid_room");
    socket.emit("room:join", { roomId: newRoomId(), name: "   " });
    assert.equal((await once(socket, "room:error")).code, "invalid_name");
  });

  it("refuses a third person, who then cannot affect the room (bug #1)", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    const intruder = connect(srv.url);
    await once(intruder, "connect");
    intruder.emit("room:join", { roomId, name: "Eve" });
    assert.match((await once(intruder, "room:full")).message, /2 people/);

    const quiet = Promise.all(
      [a.socket, b.socket].flatMap((s) => [
        never(s, "video:state"),
        never(s, "chat:message"),
        never(s, "video:peer_report"),
        never(s, "video:hash_result"),
      ]),
    );
    intruder.emit("video:control", { action: "play", position: 99 });
    intruder.emit("chat:send", { text: "hello" });
    intruder.emit("video:report", { position: 1, playing: true });
    intruder.emit("video:hash", { hash: "a".repeat(64), fileName: "x", duration: 1 });
    await quiet;
    assert.equal(srv.store.get(roomId).state, null);
  });

  it("broadcasts control state to everyone, including the sender", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    const [sa, sb] = [once(a.socket, "video:state"), once(b.socket, "video:state")];
    a.socket.emit("video:control", { action: "play", position: 12.5 });
    const [stateA, stateB] = await Promise.all([sa, sb]);
    assert.deepEqual(stateA, stateB);
    assert.equal(stateA.playing, true);
    assert.equal(stateA.position, 12.5);
    assert.equal(stateA.action, "play");
    assert.equal(stateA.seq, 1);
    assert.deepEqual(stateA.by, a.joined.you);
    assert.equal(typeof stateA.updatedAt, "number");

    const next = once(a.socket, "video:state");
    b.socket.emit("video:control", { action: "seek", position: 40 });
    const seek = await next;
    assert.equal(seek.playing, true, "seeking while playing keeps playing (bug #3)");
    assert.equal(seek.seq, 2);
    assert.deepEqual(seek.by, b.joined.you);
  });

  it("ignores invalid control payloads", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const quiet = never(a.socket, "video:state");
    a.socket.emit("video:control", { action: "seeking", position: 1 });
    a.socket.emit("video:control", { action: "play", position: -1 });
    a.socket.emit("video:control", { action: "play", position: "5" });
    a.socket.emit("video:control", "garbage");
    a.socket.emit("video:control");
    await quiet;
  });

  it("gives late joiners the current state (bug #2)", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    a.socket.emit("video:control", { action: "play", position: 30 });
    await once(a.socket, "video:state");

    const b = await join(srv.url, roomId, "Bob");
    assert.equal(b.joined.state.playing, true);
    assert.equal(b.joined.state.position, 30);
    assert.equal(b.joined.state.seq, 1);
  });

  it("compares file fingerprints once both people sent one", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    const quiet = never(a.socket, "video:hash_result", 200);
    a.socket.emit("video:hash", { hash: "a".repeat(64), fileName: "movie.mp4", duration: 100 });
    await quiet;

    const [ra, rb] = [once(a.socket, "video:hash_result"), once(b.socket, "video:hash_result")];
    b.socket.emit("video:hash", { hash: "b".repeat(64), fileName: "movie_720p.mp4", duration: 99 });
    const [resultA, resultB] = await Promise.all([ra, rb]);
    assert.equal(resultA.match, false);
    assert.deepEqual(resultA.yourFile, { fileName: "movie.mp4", duration: 100 });
    assert.deepEqual(resultA.peerFile, { fileName: "movie_720p.mp4", duration: 99 });
    assert.deepEqual(resultB.yourFile, resultA.peerFile);

    const fixed = once(a.socket, "video:hash_result");
    b.socket.emit("video:hash", { hash: "a".repeat(64), fileName: "movie.mp4", duration: 100 });
    assert.equal((await fixed).match, true);
  });

  it("relays position reports to the partner only", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    const selfQuiet = never(a.socket, "video:peer_report", 200);
    const got = once(b.socket, "video:peer_report");
    const at = Date.now() - 50;
    a.socket.emit("video:report", { position: 10, playing: true, at, seq: 3 });
    assert.deepEqual(await got, { position: 10, playing: true, at, seq: 3 });
    await selfQuiet;

    const fallback = once(b.socket, "video:peer_report");
    const before = Date.now();
    a.socket.emit("video:report", { position: 10, playing: false, at: 0 });
    const report = await fallback;
    assert.ok(report.at >= before, "a wildly wrong timestamp is replaced with server time");
    assert.equal(report.seq, null);
  });

  it("sends chat to both people, acks the sender and keeps history for rejoiners", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    const received = once(b.socket, "chat:message");
    const ack = await a.socket.timeout(2000).emitWithAck("chat:send", { text: "  hi <b>Bob</b>  " });
    const message = await received;
    assert.equal(ack.ok, true);
    assert.equal(ack.id, message.id);
    assert.equal(message.text, "hi <b>Bob</b>", "text is trimmed but otherwise untouched (rendered as text)");
    assert.deepEqual(message.from, a.joined.you);

    const bad = await a.socket.timeout(2000).emitWithAck("chat:send", { text: "   " });
    assert.deepEqual(bad, { ok: false, error: "invalid_text" });

    b.socket.disconnect();
    const c = await join(srv.url, roomId, "Carol");
    assert.equal(c.joined.chat.length, 1);
    assert.equal(c.joined.chat[0].text, "hi <b>Bob</b>");
  });

  it("tells the partner when someone leaves or disconnects", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const b = await join(srv.url, roomId, "Bob");

    let left = once(a.socket, "room:peer_left");
    await b.socket.timeout(2000).emitWithAck("room:leave", {});
    assert.equal((await left).peerId, b.joined.you.id);

    const c = await join(srv.url, roomId, "Carol");
    left = once(a.socket, "room:peer_left");
    c.socket.disconnect();
    assert.equal((await left).peerId, c.joined.you.id);
  });

  it("deletes empty rooms", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    assert.ok(srv.store.get(roomId));
    a.socket.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.get(roomId), null);
  });

  it("switching rooms leaves the previous one", async () => {
    const [room1, room2] = [newRoomId(), newRoomId()];
    const a = await join(srv.url, room1, "Alice");
    const b = await join(srv.url, room1, "Bob");
    const left = once(a.socket, "room:peer_left");
    const joined = once(b.socket, "room:joined");
    b.socket.emit("room:join", { roomId: room2, name: "Bob" });
    await Promise.all([left, joined]);
    assert.equal(srv.store.get(room1).members.size, 1);
    assert.equal(srv.store.get(room2).members.size, 1);
  });

  it("a reconnecting tab replaces its stale connection instead of hitting 'room full'", async () => {
    const roomId = newRoomId();
    const clientId = "tab-1234567890abcdef";
    const stale = await join(srv.url, roomId, "Alice", { clientId });
    const b = await join(srv.url, roomId, "Bob");

    const replaced = once(stale.socket, "room:error");
    const kicked = once(stale.socket, "disconnect");
    const peerJoined = once(b.socket, "room:peer_joined");
    const fresh = await join(srv.url, roomId, "Alice", { clientId });

    assert.equal((await replaced).code, "replaced");
    await kicked;
    assert.equal(fresh.joined.peer.name, "Bob");
    assert.equal((await peerJoined).peer.id, fresh.joined.you.id);
    assert.equal(srv.store.get(roomId).members.size, 2);
  });

  it("rate-limits chat floods", async () => {
    const roomId = newRoomId();
    const a = await join(srv.url, roomId, "Alice");
    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await a.socket.timeout(2000).emitWithAck("chat:send", { text: `msg ${i}` }));
    }
    assert.ok(results.slice(0, 5).every((r) => r.ok));
    assert.ok(results.some((r) => r.error === "rate_limited"));
  });

  it("drops oversized messages by closing the connection", async () => {
    const socket = connect(srv.url);
    await once(socket, "connect");
    const closed = once(socket, "disconnect");
    socket.emit("chat:send", { text: "x".repeat(20_000) });
    await closed;
  });

  it("serves /health", async () => {
    const res = await fetch(`${srv.url}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.rooms, "number");
  });
});

describe("origin allow-list", () => {
  let srv;
  before(async () => {
    srv = await startServer({ allowedOrigins: ["https://syncvid.netlify.app"] });
  });
  after(async () => {
    await new Promise((resolve) => srv.io.close(resolve));
  });

  it("accepts the allowed origin", async () => {
    const socket = connect(srv.url, { extraHeaders: { Origin: "https://syncvid.netlify.app" } });
    await once(socket, "connect");
  });

  it("rejects other origins", async () => {
    const socket = connect(srv.url, { extraHeaders: { Origin: "https://evil.example" } });
    await once(socket, "connect_error");
    assert.equal(socket.connected, false);
  });

  it("sends CORS headers only to allowed origins", async () => {
    const ok = await fetch(`${srv.url}/health`, { headers: { Origin: "https://syncvid.netlify.app" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://syncvid.netlify.app");
    const bad = await fetch(`${srv.url}/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  });
});
