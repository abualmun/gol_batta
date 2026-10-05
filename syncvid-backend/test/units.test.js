import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOriginChecker } from "../src/origins.js";
import { createRateLimiter } from "../src/rateLimit.js";
import { createRoomStore } from "../src/rooms.js";
import * as v from "../src/validate.js";

function makeStore(overrides = {}) {
  let t = 1000;
  let n = 0;
  const store = createRoomStore({
    maxRooms: 3,
    maxMembers: 2,
    chatHistorySize: 3,
    now: () => t,
    newId: () => `id${++n}`,
    ...overrides,
  });
  return { store, tick: (ms) => (t += ms) };
}

describe("room store", () => {
  it("allows two members and rejects the third", () => {
    const { store } = makeStore();
    assert.equal(store.join("room1", { socketId: "a", name: "A" }).ok, true);
    const b = store.join("room1", { socketId: "b", name: "B" });
    assert.equal(b.ok, true);
    assert.equal(b.peer.name, "A");
    assert.deepEqual(store.join("room1", { socketId: "c", name: "C" }), { ok: false, reason: "full" });
  });

  it("deletes a room when the last member leaves", () => {
    const { store } = makeStore();
    store.join("room1", { socketId: "a", name: "A" });
    store.join("room1", { socketId: "b", name: "B" });
    assert.equal(store.leave("room1", "a").deleted, false);
    assert.equal(store.leave("room1", "b").deleted, true);
    assert.equal(store.get("room1"), null);
    assert.equal(store.size, 0);
  });

  it("returns null when leaving a room you're not in", () => {
    const { store } = makeStore();
    store.join("room1", { socketId: "a", name: "A" });
    assert.equal(store.leave("room1", "zzz"), null);
    assert.equal(store.leave("nope", "a"), null);
  });

  it("refuses new rooms over capacity", () => {
    const { store } = makeStore();
    for (const id of ["r1", "r2", "r3"]) store.join(id, { socketId: id, name: "X" });
    assert.deepEqual(store.join("r4", { socketId: "s4", name: "X" }), { ok: false, reason: "capacity" });
  });

  it("replaces a stale member that has the same clientId, even when the room is full", () => {
    const { store } = makeStore();
    store.join("room1", { socketId: "a", clientId: "tab-A", name: "A" });
    store.join("room1", { socketId: "b", clientId: "tab-B", name: "B" });
    const again = store.join("room1", { socketId: "a2", clientId: "tab-A", name: "A" });
    assert.equal(again.ok, true);
    assert.equal(again.evicted.socketId, "a");
    assert.equal(again.room.members.size, 2);
    assert.equal(again.peer.name, "B");
  });

  it("does not treat missing clientIds as the same tab", () => {
    const { store } = makeStore();
    store.join("room1", { socketId: "a", clientId: null, name: "A" });
    const b = store.join("room1", { socketId: "b", clientId: null, name: "B" });
    assert.equal(b.evicted, null);
  });

  it("updates the name when the same socket joins again", () => {
    const { store } = makeStore();
    const first = store.join("room1", { socketId: "a", name: "A" });
    const again = store.join("room1", { socketId: "a", name: "Alice" });
    assert.equal(again.member.id, first.member.id);
    assert.equal(again.member.name, "Alice");
    assert.equal(again.room.members.size, 1);
  });

  it("applies controls with increasing seq; seek keeps the play state", () => {
    const { store, tick } = makeStore();
    const { room, member } = store.join("room1", { socketId: "a", name: "A" });

    const s1 = store.applyControl(room, member, { action: "play", position: 10 });
    assert.deepEqual(s1, {
      playing: true, position: 10, updatedAt: 1000, seq: 1, action: "play", by: { id: "id1", name: "A" },
    });
    tick(500);
    const s2 = store.applyControl(room, member, { action: "seek", position: 50 });
    assert.equal(s2.playing, true, "seeking while playing must not pause");
    assert.equal(s2.seq, 2);
    assert.equal(s2.updatedAt, 1500);

    const s3 = store.applyControl(room, member, { action: "pause", position: 51 });
    assert.equal(s3.playing, false);
    const s4 = store.applyControl(room, member, { action: "seek", position: 5 });
    assert.equal(s4.playing, false, "seeking while paused stays paused");
  });

  it("seek in a fresh room starts paused", () => {
    const { store } = makeStore();
    const { room, member } = store.join("room1", { socketId: "a", name: "A" });
    assert.equal(store.applyControl(room, member, { action: "seek", position: 3 }).playing, false);
  });

  it("compares files only when both members sent one", () => {
    const { store } = makeStore();
    const { room } = store.join("room1", { socketId: "a", name: "A" });
    store.join("room1", { socketId: "b", name: "B" });
    const fileA = { hash: "x".repeat(64), fileName: "a.mp4", duration: 100 };
    assert.equal(store.setFile(room, "a", fileA), null);

    const results = store.setFile(room, "b", { ...fileA, fileName: "b.mp4" });
    assert.equal(results.get("a").match, true);
    assert.equal(results.get("a").peerFile.fileName, "b.mp4");
    assert.equal(results.get("b").yourFile.fileName, "b.mp4");

    const differ = store.setFile(room, "b", { hash: "y".repeat(64), fileName: "c.mp4", duration: 90 });
    assert.equal(differ.get("a").match, false);
    assert.equal(differ.get("b").match, false);
  });

  it("forgets a member's file when they leave", () => {
    const { store } = makeStore();
    const { room } = store.join("room1", { socketId: "a", name: "A" });
    store.join("room1", { socketId: "b", name: "B" });
    store.setFile(room, "b", { hash: "x".repeat(64), fileName: "b", duration: null });
    store.leave("room1", "b");
    store.join("room1", { socketId: "c", name: "C" });
    assert.equal(store.setFile(room, "a", { hash: "x".repeat(64), fileName: "a", duration: null }), null);
  });

  it("keeps only the latest chat messages", () => {
    const { store } = makeStore();
    const { room, member } = store.join("room1", { socketId: "a", name: "A" });
    for (const text of ["1", "2", "3", "4", "5"]) store.addChat(room, member, text);
    assert.deepEqual(room.chat.map((m) => m.text), ["3", "4", "5"]);
    assert.deepEqual(room.chat[0].from, { id: "id1", name: "A" });
  });
});

describe("validators", () => {
  it("room ids", () => {
    assert.equal(v.roomId(" AbCd-12345 "), "abcd-12345");
    for (const bad of ["abc", "-abcd", "abcd-", "ab cd", "a".repeat(33), 42, null, "ab_cd"]) {
      assert.equal(v.roomId(bad), null, String(bad));
    }
  });

  it("names", () => {
    assert.equal(v.name("  Sara   Ali "), "Sara Ali");
    assert.equal(v.name("a\u202Eb\nc"), "ab c");
    assert.equal(v.name("x".repeat(24)), "x".repeat(24));
    assert.equal(v.name("😀".repeat(24)), "😀".repeat(24), "counts emoji as one character");
    for (const bad of ["", "   ", "x".repeat(25), 5, undefined, "\u202E"]) {
      assert.equal(v.name(bad), null, JSON.stringify(bad));
    }
  });

  it("chat text", () => {
    assert.equal(v.chatText(" hi\r\nthere "), "hi\nthere");
    assert.equal(v.chatText("a\n\n\n\n\nb"), "a\n\nb");
    assert.equal(v.chatText("tab\there\u0000"), "tab here");
    assert.equal(v.chatText("x".repeat(500)).length, 500);
    for (const bad of ["", " \n ", "x".repeat(501), {}, null]) assert.equal(v.chatText(bad), null);
  });

  it("numbers, hashes and actions", () => {
    assert.equal(v.position(0), 0);
    assert.equal(v.position(12.5), 12.5);
    for (const bad of [-1, NaN, Infinity, "3", null, 2e6]) assert.equal(v.position(bad), null);
    assert.equal(v.duration(null), null);
    assert.equal(v.duration(undefined), null);
    assert.equal(v.duration(-5), undefined);
    assert.equal(v.hash("a".repeat(64)), "a".repeat(64));
    assert.equal(v.hash("A".repeat(64)), null);
    assert.equal(v.hash("a".repeat(63)), null);
    assert.equal(v.action("seek"), "seek");
    assert.equal(v.action("seeking"), null);
    assert.equal(v.serverTimestamp(1000, 5000), 1000);
    assert.equal(v.serverTimestamp(1000, 100_000), null);
  });

  it("file names and client ids", () => {
    assert.equal(v.fileName("movie\u0000.mp4"), "movie .mp4");
    assert.equal(v.fileName(""), "Unknown file");
    assert.equal(v.fileName(7), "Unknown file");
    assert.equal(v.fileName("x".repeat(300)).length, 200);
    assert.equal(v.clientId("abcDEF123_-abcdef"), "abcDEF123_-abcdef");
    assert.equal(v.clientId("short"), null);
  });
});

describe("origin checker", () => {
  it("allows everything when no patterns are set", () => {
    assert.equal(createOriginChecker([])("https://anything.example"), true);
  });

  it("matches exact origins and * wildcards", () => {
    const check = createOriginChecker(["https://syncvid.netlify.app", "https://*--syncvid.netlify.app"]);
    assert.equal(check("https://syncvid.netlify.app"), true);
    assert.equal(check("https://deploy-preview-12--syncvid.netlify.app"), true);
    assert.equal(check("https://evil.com"), false);
    assert.equal(check("https://syncvid.netlify.app.evil.com"), false);
    assert.equal(check("https://a.b--syncvid.netlify.app"), false, "* must not match dots");
    assert.equal(check(undefined), true, "non-browser clients have no Origin");
  });
});

describe("rate limiter", () => {
  it("allows a burst, then refills over time", () => {
    let t = 0;
    const allow = createRateLimiter({ e: { capacity: 2, refillPerSec: 1 } }, () => t);
    assert.equal(allow("e"), true);
    assert.equal(allow("e"), true);
    assert.equal(allow("e"), false);
    t += 1000;
    assert.equal(allow("e"), true);
    assert.equal(allow("e"), false);
    assert.equal(allow("unknown-event"), true);
  });
});
