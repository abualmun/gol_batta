/**
 * Sync engine: keeps the local <video> in step with the room state held by the server.
 *
 * - Local play/pause/seek → `video:control` request. The server answers everyone (us too)
 *   with `video:state`, which is the single source of truth.
 * - Changes we make to the player ourselves are recorded as "expectations" so the
 *   resulting media events are not mistaken for user actions (no echo loops).
 * - Drift: every few seconds each side reports its position. If we are AHEAD of the
 *   partner by more than DRIFT_THRESHOLD_S we jump back. We never jump forward, so
 *   nobody misses part of the video.
 */

import { DRIFT_THRESHOLD_S, REPORT_INTERVAL_MS, SEEK_TOLERANCE_S } from "./config.js";

const EXPECTATION_TTL_MS = 3000;
const PENDING_OWN_TTL_MS = 5000;
const SEEK_DEBOUNCE_MS = 300;
/** Don't correct drift right after a play/pause/seek — reports from before it are stale. */
const DRIFT_QUIET_MS = 2500;
/** A partner report older than this no longer describes where they are. */
const PEER_REPORT_TTL_MS = REPORT_INTERVAL_MS * 3;

/**
 * @param {object} deps
 * @param {HTMLVideoElement} deps.video
 * @param {ReturnType<import("./connection.js").createConnection>} deps.conn
 * @param {(type: string, detail?: object) => void} deps.onEvent
 *   "remote-action" (state), "local-action" ({action, position}), "needs-tap" ({needed}),
 *   "drift-corrected" ({seconds}), "peer-report"
 */
export function createSyncEngine({ video, conn, onEvent }) {
  let active = false; // true while the theater is shown and a file is loaded
  let myId = null;
  let roomState = null;
  let lastSeq = 0;
  let pendingOwn = []; // timestamps of our control requests not yet echoed back
  let expectations = []; // { type, until }
  let remotePlayPending = false;
  let needsTap = false;
  let seekTimer = null;
  let lastApplyAt = -Infinity;
  let lastLocalActionAt = -Infinity;
  let peerReport = null; // { position, playing, at, seq, receivedAt }
  let reportTimer = null;

  const now = () => performance.now();
  const hasMedia = () => Boolean(video.currentSrc) && video.readyState >= HTMLMediaElement.HAVE_METADATA;

  // ─── Expectations (echo guard) ─────────────────────────────────────────────
  function expect(type) {
    expectations.push({ type, until: now() + EXPECTATION_TTL_MS });
  }

  function consume(type) {
    const t = now();
    expectations = expectations.filter((e) => e.until > t);
    const index = expectations.findIndex((e) => e.type === type);
    if (index === -1) return false;
    expectations.splice(index, 1);
    return true;
  }

  function dropExpectation(type) {
    const index = expectations.findIndex((e) => e.type === type);
    if (index !== -1) expectations.splice(index, 1);
  }

  function setNeedsTap(value) {
    if (needsTap === value) return;
    needsTap = value;
    onEvent("needs-tap", { needed: value });
  }

  // ─── Room state → player ───────────────────────────────────────────────────
  function expectedPosition(state) {
    if (!state.playing) return state.position;
    const elapsedS = Math.max(0, conn.serverNow() - state.updatedAt) / 1000;
    return state.position + elapsedS;
  }

  function clampToDuration(position) {
    const d = video.duration;
    return Number.isFinite(d) ? Math.min(position, Math.max(0, d - 0.05)) : position;
  }

  /** Make the player match the room state. Safe to call repeatedly. */
  function apply() {
    if (!active || !roomState || !hasMedia()) return;
    lastApplyAt = now();
    const state = roomState;
    const target = clampToDuration(expectedPosition(state));

    if (Math.abs(video.currentTime - target) > SEEK_TOLERANCE_S) {
      expect("seeked");
      video.currentTime = target;
    }

    if (state.playing && video.paused) {
      expect("play");
      remotePlayPending = true;
      video
        .play()
        .then(() => setNeedsTap(false))
        .catch((err) => {
          dropExpectation("play");
          // Browsers block playback that the user didn't start (mostly phones).
          if (err?.name === "NotAllowedError") setNeedsTap(true);
        })
        .finally(() => {
          remotePlayPending = false;
        });
    } else if (!state.playing) {
      setNeedsTap(false);
      if (!video.paused) {
        expect("pause");
        video.pause();
      }
    }
  }

  // ─── Player → server ───────────────────────────────────────────────────────
  function sendControl(action) {
    if (!active || !hasMedia() || !myId) return;
    if (action !== "seek") flushSeek();
    lastLocalActionAt = now();
    const t = now();
    pendingOwn = pendingOwn.filter((sentAt) => t - sentAt < PENDING_OWN_TTL_MS);
    if (conn.socket.connected) pendingOwn.push(t);
    const position = video.currentTime;
    conn.emit("video:control", { action, position });
    onEvent("local-action", { action, position });
  }

  function flushSeek() {
    if (seekTimer === null) return;
    clearTimeout(seekTimer);
    seekTimer = null;
    sendControl("seek");
  }

  function scheduleSeek() {
    // Scrubbing fires many "seeked" events; send only where the user stops.
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      seekTimer = null;
      sendControl("seek");
    }, SEEK_DEBOUNCE_MS);
  }

  video.addEventListener("play", () => {
    if (!active || consume("play")) return;
    setNeedsTap(false);
    sendControl("play");
  });

  video.addEventListener("pause", () => {
    if (!active || remotePlayPending || consume("pause")) return;
    sendControl("pause");
  });

  video.addEventListener("seeked", () => {
    if (!active || consume("seeked")) return;
    scheduleSeek();
  });

  video.addEventListener("loadedmetadata", () => apply());

  // ─── Drift ─────────────────────────────────────────────────────────────────
  function sendReport() {
    if (!active || !hasMedia() || !myId) return;
    conn.emit("video:report", {
      position: video.currentTime,
      playing: !video.paused && !video.ended,
      at: conn.serverNow(),
      seq: lastSeq,
    });
  }

  function peerPositionNow() {
    if (!peerReport || now() - peerReport.receivedAt > PEER_REPORT_TTL_MS) return null;
    const elapsedS = peerReport.playing ? Math.max(0, conn.serverNow() - peerReport.at) / 1000 : 0;
    return peerReport.position + elapsedS;
  }

  function handlePeerReport(report) {
    peerReport = { ...report, receivedAt: now() };
    onEvent("peer-report");

    if (!active || !hasMedia()) return;
    if (report.seq !== lastSeq) return; // partner hasn't caught up with the latest action yet
    if (!report.playing || video.paused || video.seeking) return;
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    const t = now();
    if (t - lastApplyAt < DRIFT_QUIET_MS || t - lastLocalActionAt < DRIFT_QUIET_MS) return;

    const peerNow = peerPositionNow();
    const drift = video.currentTime - peerNow;
    if (drift > DRIFT_THRESHOLD_S) {
      expect("seeked");
      video.currentTime = peerNow;
      onEvent("drift-corrected", { seconds: drift });
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  return {
    /** Called on every `room:joined` (first join and every reconnect). */
    handleJoined({ you, state }, { rejoin }) {
      myId = you.id;
      pendingOwn = [];
      peerReport = null;
      lastSeq = state?.seq ?? 0;
      roomState = state ?? null;
      if (roomState) {
        apply();
      } else if (rejoin && active && hasMedia()) {
        // The server restarted and forgot the room: restore it from our player.
        sendControl(video.paused ? "pause" : "play");
      }
    },

    handleState(state) {
      if (state.seq <= lastSeq) return; // out of date
      lastSeq = state.seq;
      roomState = state;
      const t = now();
      pendingOwn = pendingOwn.filter((sentAt) => t - sentAt < PENDING_OWN_TTL_MS);
      if (state.by?.id === myId) {
        pendingOwn.shift();
        // More of our own requests are in flight; the last one will settle the state.
        if (pendingOwn.length > 0) return;
      } else {
        onEvent("remote-action", state);
      }
      apply();
    },

    handlePeerReport,

    handlePeerLeft() {
      peerReport = null;
      onEvent("peer-report");
    },

    /** Start syncing (theater shown with a file loaded). */
    activate() {
      active = true;
      clearInterval(reportTimer);
      reportTimer = setInterval(sendReport, REPORT_INTERVAL_MS);
      apply();
    },

    deactivate() {
      active = false;
      clearInterval(reportTimer);
      clearTimeout(seekTimer);
      seekTimer = null;
      expectations = [];
      setNeedsTap(false);
    },

    /** Must be called from a click/tap handler so the browser allows playback. */
    tapToSync() {
      setNeedsTap(false);
      apply();
    },

    /** Re-apply the room state, e.g. after loading a different file. */
    resync: apply,

    get roomState() {
      return roomState;
    },
    peerPositionNow,
    get peerPlaying() {
      return peerPositionNow() === null ? null : peerReport.playing;
    },
  };
}
