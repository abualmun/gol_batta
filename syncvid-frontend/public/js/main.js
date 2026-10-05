/**
 * Gol Batta app controller: routing, screens, and wiring between the connection,
 * sync engine, chat panel and subtitles.
 */

import {
  BACKEND_URL,
  DRIFT_THRESHOLD_S,
  DURATION_TOLERANCE_S,
  HASH_SAMPLE_BYTES,
  NAME_MAX_LENGTH,
} from "./config.js";
import { createConnection } from "./connection.js";
import { fingerprintFile } from "./hash.js";
import { generateClientId, generateRoomId, parseRoomInput, roomIdFromPath } from "./ids.js";
import { createPanel } from "./panel.js";
import { createSubtitles, OFFSET_STEP_S } from "./subtitles.js";
import { createSyncEngine } from "./sync.js";
import { $, announce, canNativeShare, formatTime, shareLink, storage, toast } from "./ui.js";

const PEER_LEFT_GRACE_MS = 5000;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|webm|mov|avi|ogv|ogg|3gp|ts|m2ts|wmv|flv)$/i;
const BANNER_DELAY_MS = 1200;
const WAKE_HINT_DELAY_MS = 5000;
/** Render's free plan sleeps after 15 min without HTTP requests; nudge it while a room is open. */
const KEEP_AWAKE_MS = 5 * 60 * 1000;

// ─── State ───────────────────────────────────────────────────────────────────
const app = {
  screen: null,
  roomId: null,
  name: storage.get("localStorage", "syncvid:name") || "",
  clientId: null,
  joined: false,
  hasJoinedBefore: false,
  clockReady: false,
  you: null,
  peer: null,
  peerLeaving: null, // { peer, timer } while a partner's disconnect may be a quick reconnect
  problem: null,
  file: null,
  fileUrl: null,
  fileHash: null,
  fileToken: 0,
  everConnected: false,
  connection: "connecting",
};

app.clientId = storage.get("sessionStorage", "syncvid:clientId");
if (!app.clientId) {
  app.clientId = generateClientId();
  storage.set("sessionStorage", "syncvid:clientId", app.clientId);
}

const video = $("#video");

// ─── Core modules ────────────────────────────────────────────────────────────
const conn = createConnection(BACKEND_URL, {
  onStatus: handleConnectionStatus,
  onReady() {
    app.clockReady = true;
    tryJoin();
  },
});

const engine = createSyncEngine({ video, conn, onEvent: handleEngineEvent });
const panel = createPanel({ conn, getMyId: () => app.you?.id });
const subtitles = createSubtitles(video, { onChange: renderSubtitles });

// ─── Helpers ─────────────────────────────────────────────────────────────────
const peerName = () => app.peer?.name || "your friend";
const roomUrl = () => `${location.origin}/room/${app.roomId}`;

function cleanName(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

function validateName(raw) {
  const name = cleanName(raw);
  if (!name) return { error: "Enter your name so your friend knows who's watching." };
  if ([...name].length > NAME_MAX_LENGTH) return { error: `Use ${NAME_MAX_LENGTH} characters or fewer.` };
  return { name };
}

function setFieldError(input, errorEl, message) {
  errorEl.textContent = message || "";
  errorEl.hidden = !message;
  if (message) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
  } else {
    input.removeAttribute("aria-invalid");
  }
}

function saveName(name) {
  app.name = name;
  storage.set("localStorage", "syncvid:name", name);
}

// ─── Screens & routing ───────────────────────────────────────────────────────
function showScreen(name) {
  if (app.screen === name) return;
  app.screen = name;
  for (const id of ["home", "room", "theater"]) $(`#screen-${id}`).hidden = id !== name;
  document.body.dataset.screen = name;
  // Move focus to the new screen's heading so screen readers announce it.
  const heading = $(`#screen-${name} h1`);
  heading?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  updateTitle();
  updateConnectionBanner();
}

function updateTitle() {
  document.title =
    app.screen === "home" || !app.roomId
      ? "Gol Batta: watch together"
      : app.peer
        ? `With ${app.peer.name} · Gol Batta`
        : `Room ${app.roomId} · Gol Batta`;
}

function route() {
  const roomId = roomIdFromPath(location.pathname);
  if (roomId) {
    enterRoom(roomId);
    return;
  }
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  if (app.roomId) leaveRoom();
  showHome();
}

function navigate(path) {
  history.pushState(null, "", path);
  route();
}

window.addEventListener("popstate", route);

// ─── Home ────────────────────────────────────────────────────────────────────
function showHome() {
  $("#name-input").value = app.name;
  showScreen("home");
}

$("#create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#name-input");
  const { name, error } = validateName(input.value);
  setFieldError(input, $("#name-error"), error);
  if (error) return;
  saveName(name);
  navigate(`/room/${generateRoomId()}`);
});

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nameInput = $("#name-input");
  const { name, error } = validateName(nameInput.value);
  setFieldError(nameInput, $("#name-error"), error);
  if (error) return;
  const joinInput = $("#join-input");
  const roomId = parseRoomInput(joinInput.value);
  setFieldError(
    joinInput,
    $("#join-error"),
    roomId ? "" : "That doesn't look like a room link or code. Check it and try again.",
  );
  if (!roomId) return;
  saveName(name);
  joinInput.value = "";
  navigate(`/room/${roomId}`);
});

// ─── Room ────────────────────────────────────────────────────────────────────
function enterRoom(roomId) {
  if (app.roomId && app.roomId !== roomId) leaveRoom();
  if (app.roomId !== roomId) {
    app.roomId = roomId;
    app.hasJoinedBefore = false;
    panel.clear();
    $("#room-code-text").textContent = roomId;
    $("#share-url").value = roomUrl();
    $(".share-label").textContent = canNativeShare() ? "Share link" : "Copy link";
  }
  setProblem(null);
  // Arriving via browser back/forward while already watching: stay in the theater.
  if (app.screen !== "theater") showScreen("room");

  const needsName = !app.name;
  $("#room-name-form").hidden = !needsName;
  if (needsName) {
    $("#room-name-input").focus();
  }
  renderPartnerStatus();
  tryJoin();
}

function tryJoin() {
  if (!app.roomId || !app.name || app.problem || !app.clockReady || !conn.socket.connected) return;
  conn.emit("room:join", { roomId: app.roomId, name: app.name, clientId: app.clientId });
}

function leaveRoom() {
  if (app.joined) conn.emit("room:leave", {});
  engine.deactivate();
  video.pause();
  clearTimeout(app.peerLeaving?.timer);
  Object.assign(app, { roomId: null, joined: false, you: null, peer: null, peerLeaving: null, problem: null });
  $("#mismatch-banner").hidden = true;
  $("#tap-to-sync").hidden = true;
  closeDrawer();
  panel.clear();
}

$("#room-name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#room-name-input");
  const { name, error } = validateName(input.value);
  setFieldError(input, $("#room-name-error"), error);
  if (error) return;
  saveName(name);
  $("#room-name-form").hidden = true;
  renderPartnerStatus();
  tryJoin();
});

$("#room-home-link").addEventListener("click", (e) => {
  e.preventDefault();
  navigate("/");
});

$("#room-problem-home").addEventListener("click", (e) => {
  e.preventDefault();
  navigate("/");
});

const PROBLEMS = {
  full: {
    title: "This room is full",
    text: "Rooms hold two people, and two are already here. Create a new room to watch with someone else.",
    action: "Create a new room",
  },
  invalid: {
    title: "This room link isn't valid",
    text: "Check that the whole link was copied, or create a new room.",
    action: "Create a new room",
  },
  replaced: {
    title: "This room is open in another window",
    text: "You can be in a room from one window at a time.",
    action: "Use it in this window",
  },
  busy: {
    title: "The server is busy",
    text: "Too many rooms are open right now. Try again in a minute.",
    action: "Try again",
  },
};

function setProblem(kind) {
  app.problem = kind;
  const box = $("#room-problem");
  box.hidden = !kind;
  $("#room-setup").hidden = Boolean(kind);
  if (!kind) return;
  const { title, text, action } = PROBLEMS[kind];
  $("#room-problem-title").textContent = title;
  $("#room-problem-text").textContent = text;
  $("#room-problem-action").textContent = action;
  $("#room-name-form").hidden = true;
  if (app.screen === "theater") {
    engine.deactivate();
    video.pause();
  }
  showScreen("room");
  $("#room-problem-action").focus();
}

$("#room-problem-action").addEventListener("click", () => {
  const kind = app.problem;
  if (kind === "replaced" || kind === "busy") {
    setProblem(null);
    tryJoin();
  } else {
    navigate(`/room/${generateRoomId()}`);
  }
});

// ─── Partner status ──────────────────────────────────────────────────────────
function partnerStatus() {
  if (!app.joined) {
    if (!app.name) return { state: "joining", text: "Enter your name to join" };
    return { state: "joining", text: conn.socket.connected ? "Joining the room…" : "Connecting…" };
  }
  if (app.peerLeaving) return { state: "offline", text: `${app.peerLeaving.peer.name} lost connection…` };
  if (app.peer) return { state: "here", text: `${app.peer.name} is here` };
  return { state: "waiting", text: "Waiting for your friend to join" };
}

function renderPartnerStatus() {
  const { state, text } = partnerStatus();
  for (const [box, label] of [
    [$("#partner-status"), $("#partner-status-text")],
    [$("#bar-partner"), $("#bar-partner-text")],
  ]) {
    box.dataset.state = state;
    label.textContent = text;
  }
  $("#tap-to-sync-text").textContent = app.peer ? `Tap to play along with ${app.peer.name}` : "Tap to play";
  panel.setPeerName(app.peer?.name);
  updateTitle();
  renderStrip();
}

// ─── Video file ──────────────────────────────────────────────────────────────
function looksLikeVideo(file) {
  if (file.type.startsWith("video/")) return true;
  // Some systems report no type (or a generic one) for .mkv etc.
  return VIDEO_EXTENSIONS.test(file.name) && (!file.type || file.type === "application/octet-stream");
}

function setFileStatus(text, tone = "") {
  const el = $("#file-status");
  el.textContent = text;
  el.dataset.tone = tone;
}

function waitForMetadata() {
  return new Promise((resolve) => {
    const done = (ok) => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
      resolve(ok);
    };
    const onLoaded = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(video.readyState >= 1), 15_000);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

async function handleVideoFile(file) {
  if (!file) return;
  if (!looksLikeVideo(file)) {
    setFileStatus("That isn't a video file. Choose a video such as an .mp4 file.", "warn");
    return;
  }
  const token = ++app.fileToken;
  app.file = file;
  app.fileHash = null;
  $("#start-btn").disabled = true;
  $("#dropzone").classList.add("has-file");
  $("#dropzone-title").textContent = file.name;
  $("#dropzone-hint").textContent = "Choose a different file";
  setFileStatus("Opening the video…");

  if (app.fileUrl) URL.revokeObjectURL(app.fileUrl);
  app.fileUrl = URL.createObjectURL(file);
  video.src = app.fileUrl;
  subtitles.refresh();

  const playable = await waitForMetadata();
  if (token !== app.fileToken) return;
  if (!playable) {
    setFileStatus(
      "This browser can't play that file. Try an .mp4 version, or open Gol Batta in another browser.",
      "warn",
    );
    $("#dropzone").classList.remove("has-file");
    return;
  }

  setFileStatus("Checking the file…");
  let hash;
  try {
    hash = await fingerprintFile(file, HASH_SAMPLE_BYTES);
  } catch {
    if (token !== app.fileToken) return;
    setFileStatus("That file couldn't be read. Try choosing it again.", "warn");
    return;
  }
  if (token !== app.fileToken) return;
  app.fileHash = hash;

  const length = formatTime(video.duration);
  if (video.videoWidth === 0) {
    setFileStatus(
      `Ready (${length}), but this browser may only play the sound of this file. An .mp4 version works best.`,
      "warn",
    );
  } else {
    setFileStatus(`Ready to watch · ${length} long`, "ok");
  }
  $("#start-btn").disabled = false;
  sendFileInfo();
  if (app.screen === "theater") {
    panel.log("you", `You opened ${file.name}.`);
    engine.resync();
  }
}

function sendFileInfo() {
  if (!app.joined || !app.fileHash) return;
  conn.emit("video:hash", {
    hash: app.fileHash,
    fileName: app.file.name,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  });
}

$("#video-input").addEventListener("change", (e) => {
  handleVideoFile(e.target.files[0]);
  e.target.value = "";
});

const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  handleVideoFile(e.dataTransfer.files[0]);
});
// A file dropped anywhere else would make the browser open it and leave the app.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

video.addEventListener("error", () => {
  if (app.screen === "theater" && video.src) {
    toast("The video stopped working in this browser.", { tone: "warn" });
    panel.log("warn", "Playback error: this browser couldn't keep playing the file.");
  }
});

// ─── Theater ─────────────────────────────────────────────────────────────────
let stripTimer = null;

$("#start-btn").addEventListener("click", () => {
  showScreen("theater");
  engine.activate();
  clearInterval(stripTimer);
  stripTimer = setInterval(renderStrip, 500);
  renderStrip();
  panel.log("system", app.peer ? `${app.peer.name} is in the room.` : "Waiting for your friend to join.");
});

function renderStrip() {
  if (app.screen !== "theater") return;
  const duration = video.duration;
  const pct = (t) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  const haveDuration = Number.isFinite(duration) && duration > 0;
  const mine = video.currentTime;

  $("#strip-you").style.left = haveDuration ? pct(mine) : "0%";
  $("#strip-fill").style.width = haveDuration ? pct(mine) : "0%";

  const peerPos = app.peer ? engine.peerPositionNow() : null;
  const peerEl = $("#strip-peer");
  peerEl.hidden = peerPos === null || !haveDuration;
  if (!peerEl.hidden) peerEl.style.left = pct(peerPos);

  const status = $("#strip-status");
  let text;
  let tone = "";
  if (!app.peer) {
    text = app.peerLeaving ? `${app.peerLeaving.peer.name} lost connection` : "Waiting for your friend";
  } else if (peerPos === null) {
    text = `${app.peer.name} hasn't started yet`;
  } else {
    const drift = mine - peerPos;
    const bothPaused = video.paused && engine.peerPlaying === false;
    if (Math.abs(drift) <= DRIFT_THRESHOLD_S) {
      text = bothPaused ? "Both paused, in sync" : "In sync";
      tone = "ok";
    } else if (engine.peerPlaying === false && !video.paused) {
      text = `${app.peer.name} is paused at ${formatTime(peerPos)}`;
      tone = "warn";
    } else {
      const seconds = Math.round(Math.abs(drift));
      text = `${app.peer.name} is ${seconds}s ${drift > 0 ? "behind" : "ahead"}`;
      tone = "warn";
    }
  }
  if (status.textContent !== text) status.textContent = text;
  status.dataset.tone = tone;
}

// Brief message over the video ("Sam paused").
let noticeTimer = null;
function stageNotice(text) {
  const el = $("#stage-notice");
  el.textContent = text;
  el.classList.add("visible");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("visible"), 2500);
}

$("#tap-to-sync").addEventListener("click", () => engine.tapToSync());

$("#mismatch-close").addEventListener("click", () => {
  $("#mismatch-banner").hidden = true;
});

// Share / invite
async function share() {
  const result = await shareLink(roomUrl(), "Watch with me on Gol Batta");
  if (result === "copied") toast("Link copied. Send it to your friend.");
  else if (result === "failed") toast("Couldn't copy. Select the link and copy it yourself.", { tone: "warn" });
}
$("#share-btn").addEventListener("click", share);
$("#bar-share-btn").addEventListener("click", share);
$("#share-url").addEventListener("focus", (e) => e.target.select());

// Leave (two taps, so a stray tap on a phone doesn't end the session)
let leaveArmed = null;
$("#leave-btn").addEventListener("click", () => {
  const label = $("#leave-btn span");
  if (!leaveArmed) {
    label.textContent = "Tap again";
    announce("Press Leave again to leave the room.");
    leaveArmed = setTimeout(() => {
      leaveArmed = null;
      label.textContent = "Leave";
    }, 3000);
    return;
  }
  clearTimeout(leaveArmed);
  leaveArmed = null;
  label.textContent = "Leave";
  clearInterval(stripTimer);
  navigate("/");
});

// Chat drawer (phones in landscape)
function openDrawer() {
  const sidePanel = $("#side-panel");
  sidePanel.classList.add("open");
  $("#chat-toggle").setAttribute("aria-expanded", "true");
  panel.shown();
  panel.focusInput();
}

function closeDrawer() {
  const sidePanel = $("#side-panel");
  if (!sidePanel.classList.contains("open")) return;
  sidePanel.classList.remove("open");
  $("#chat-toggle").setAttribute("aria-expanded", "false");
  $("#chat-toggle").focus();
}

$("#chat-toggle").addEventListener("click", () => {
  if ($("#side-panel").classList.contains("open")) closeDrawer();
  else openDrawer();
});
$("#drawer-close").addEventListener("click", closeDrawer);

document.addEventListener("syncvid:unread", (e) => {
  const badge = $("#chat-toggle-badge");
  badge.hidden = e.detail === 0;
  badge.textContent = e.detail > 9 ? "9+" : String(e.detail);
});

// Keyboard shortcuts in the theater (desktop)
document.addEventListener("keydown", (e) => {
  if (app.screen !== "theater" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") {
    closeDrawer();
    return;
  }
  const target = e.target;
  if (target.closest("input, textarea, select, button, a, video, dialog, [contenteditable]")) return;
  if (!video.src) return;
  switch (e.key) {
    case " ":
    case "k":
      e.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    case "ArrowRight":
      e.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      break;
    case "f": {
      e.preventDefault();
      const stage = $("#stage");
      if (document.fullscreenElement) document.exitFullscreen?.();
      else stage.requestFullscreen?.().catch(() => {});
      break;
    }
    case "c":
      e.preventDefault();
      if (getComputedStyle($("#chat-toggle")).display !== "none") openDrawer();
      else panel.focusInput();
      break;
    default:
  }
});

// Coming back to the tab: phones may have paused the video in the background.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  panel.shown();
  if (app.screen === "theater") engine.resync();
});

// Warn before closing/refreshing mid-session: the file would have to be picked again.
window.addEventListener("beforeunload", (e) => {
  if (app.screen === "theater" && app.file) e.preventDefault();
});

// ─── Subtitles ───────────────────────────────────────────────────────────────
function renderSubtitles({ loaded, fileName, offset, visible, count }) {
  for (const el of document.querySelectorAll(".subs-status")) {
    el.textContent = loaded ? `${fileName} (${count} lines)` : "No subtitles loaded.";
  }
  $(".subs-pick-label").textContent = loaded ? "Choose a different file" : "Choose a .srt or .vtt file";
  $("#subs-controls").hidden = !loaded;
  $("#subs-show").checked = visible;
  $("#subs-offset").textContent =
    offset === 0 ? "On time" : `${Math.abs(offset).toFixed(1)} s ${offset < 0 ? "earlier" : "later"}`;
}

for (const input of document.querySelectorAll(".subs-file-input")) {
  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const result = await subtitles.load(file);
    if (result.ok) {
      toast(`Subtitles added: ${file.name}`);
      if (app.screen === "theater") panel.log("you", `You added subtitles (${file.name}).`);
    } else {
      toast(result.error, { tone: "warn" });
    }
  });
}

$("#subs-btn").addEventListener("click", () => $("#subs-dialog").showModal());
$("#subs-show").addEventListener("change", (e) => subtitles.setVisible(e.target.checked));
$("#subs-earlier").addEventListener("click", () => subtitles.shift(-OFFSET_STEP_S));
$("#subs-later").addEventListener("click", () => subtitles.shift(OFFSET_STEP_S));
$("#subs-remove").addEventListener("click", () => subtitles.remove());
// Close the dialog when tapping the dimmed backdrop.
$("#subs-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// ─── Connection status ───────────────────────────────────────────────────────
let bannerTimer = null;
let wakeHintTimer = null;

function handleConnectionStatus(status) {
  const was = app.connection;
  app.connection = status;
  if (status === "connected") {
    if (app.everConnected && was !== "connected") toast("Connected again.");
    app.everConnected = true;
  } else {
    app.clockReady = false;
    app.joined = false;
  }
  updateConnectionBanner();
  renderPartnerStatus();
}

function updateConnectionBanner() {
  const banner = $("#connection-banner");
  const status = app.connection;
  const relevant = app.screen === "room" || app.screen === "theater";

  if (status === "connected" || !relevant) {
    clearTimeout(bannerTimer);
    clearTimeout(wakeHintTimer);
    bannerTimer = wakeHintTimer = null;
    banner.hidden = true;
    return;
  }

  const firstConnect = !app.everConnected;
  $("#connection-title").textContent = firstConnect
    ? "Connecting to the server…"
    : "Connection lost. Reconnecting…";
  $("#connection-retry").hidden = status !== "failed";

  if (banner.hidden && !bannerTimer) {
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      if (app.connection !== "connected") banner.hidden = false;
    }, firstConnect ? BANNER_DELAY_MS : 0);
  }
  if (firstConnect && !wakeHintTimer) {
    $("#connection-detail").textContent = "";
    wakeHintTimer = setTimeout(() => {
      $("#connection-detail").textContent =
        "The server sleeps when nobody is using it. Waking it up can take up to a minute. You can choose your video meanwhile.";
    }, WAKE_HINT_DELAY_MS);
  } else if (!firstConnect) {
    $("#connection-detail").textContent = "Check your internet connection. Your video keeps playing.";
  }
}

$("#connection-retry").addEventListener("click", () => conn.socket.connect());

// ─── Server events ───────────────────────────────────────────────────────────
conn.on("room:joined", (data) => {
  if (data.roomId !== app.roomId) {
    // We left (or switched rooms) while the join was in flight.
    conn.emit("room:leave", {});
    return;
  }
  const rejoin = app.hasJoinedBefore;
  Object.assign(app, { joined: true, hasJoinedBefore: true, you: data.you, peer: data.peer });
  setProblem(null);
  panel.loadHistory(data.chat);
  engine.handleJoined(data, { rejoin });
  sendFileInfo();
  renderPartnerStatus();
  if (rejoin) panel.log("system", "Reconnected to the room.");
  else if (data.peer) panel.log("peer", `${data.peer.name} is already here.`);
});

conn.on("room:full", () => setProblem("full"));

conn.on("room:error", ({ code, message }) => {
  switch (code) {
    case "invalid_room":
      setProblem("invalid");
      break;
    case "replaced":
      app.joined = false;
      setProblem("replaced");
      break;
    case "server_busy":
      setProblem("busy");
      break;
    case "invalid_name":
      app.name = "";
      $("#room-name-form").hidden = false;
      setFieldError($("#room-name-input"), $("#room-name-error"), message);
      break;
    default:
      if (message) toast(message, { tone: "warn" });
  }
});

conn.on("room:peer_joined", ({ peer }) => {
  const leaving = app.peerLeaving;
  const quickReturn = leaving && leaving.peer.name === peer.name;
  if (leaving) clearTimeout(leaving.timer);
  const previous = app.peer;
  app.peerLeaving = null;
  app.peer = peer;
  renderPartnerStatus();

  if (quickReturn || (previous && previous.name === peer.name)) {
    panel.log("peer", `${peer.name} reconnected.`);
    return;
  }
  toast(`${peer.name} joined`);
  announce(`${peer.name} joined the room.`);
  panel.log("peer", `${peer.name} joined the room.`);
  panel.addChatNotice(`${peer.name} joined`);
});

conn.on("room:peer_left", ({ peerId }) => {
  if (app.peer?.id !== peerId) return;
  const peer = app.peer;
  app.peer = null;
  engine.handlePeerLeft();
  $("#mismatch-banner").hidden = true;
  // Wait a moment: a phone that briefly lost signal usually comes straight back.
  app.peerLeaving = {
    peer,
    timer: setTimeout(() => {
      app.peerLeaving = null;
      renderPartnerStatus();
      toast(`${peer.name} left`);
      panel.log("warn", `${peer.name} left the room.`);
      panel.addChatNotice(`${peer.name} left`);
    }, PEER_LEFT_GRACE_MS),
  };
  renderPartnerStatus();
});

conn.on("video:state", (state) => engine.handleState(state));
conn.on("video:peer_report", (report) => engine.handlePeerReport(report));

conn.on("video:hash_result", ({ match, yourFile, peerFile }) => {
  const banner = $("#mismatch-banner");
  const durationsDiffer =
    yourFile.duration !== null &&
    peerFile.duration !== null &&
    Math.abs(yourFile.duration - peerFile.duration) > DURATION_TOLERANCE_S;
  if (match) {
    banner.hidden = true;
    panel.log("system", `Your video matches ${peerName()}'s.`);
    return;
  }
  const describe = (f) => (f.duration === null ? f.fileName : `${f.fileName} (${formatTime(f.duration)})`);
  $("#mismatch-detail").textContent =
    `You have ${describe(yourFile)}; ${peerName()} has ${describe(peerFile)}. ` +
    (durationsDiffer
      ? "They have different lengths, so you'll see different scenes."
      : "Playback still works, but scenes may not line up.");
  banner.hidden = false;
  panel.log("warn", `Your video file is different from ${peerName()}'s.`);
});

conn.on("chat:message", (message) => {
  panel.receive(message);
  if (message.from.id !== app.you?.id && app.screen === "theater") {
    const chatHidden = getComputedStyle($("#chat-toggle")).display !== "none" && !$("#side-panel").classList.contains("open");
    if (chatHidden) stageNotice(`${message.from.name}: ${message.text.slice(0, 60)}${message.text.length > 60 ? "…" : ""}`);
  }
});

// ─── Sync engine events ──────────────────────────────────────────────────────
function handleEngineEvent(type, detail) {
  switch (type) {
    case "remote-action": {
      const who = detail.by?.name ?? peerName();
      const at = formatTime(detail.position);
      const text =
        detail.action === "play"
          ? `${who} pressed play at ${at}`
          : detail.action === "pause"
            ? `${who} paused at ${at}`
            : `${who} jumped to ${at}`;
      panel.log("peer", text);
      stageNotice(text);
      break;
    }
    case "local-action": {
      const at = formatTime(detail.position);
      const text =
        detail.action === "play"
          ? `You pressed play at ${at}`
          : detail.action === "pause"
            ? `You paused at ${at}`
            : `You jumped to ${at}`;
      panel.log("you", text);
      break;
    }
    case "needs-tap":
      $("#tap-to-sync").hidden = !detail.needed;
      if (detail.needed) announce(`${peerName()} is playing. Press the play button to join in.`);
      break;
    case "drift-corrected":
      panel.log("system", `You were ${detail.seconds.toFixed(1)}s ahead, so your video stepped back to match.`);
      break;
    case "peer-report":
      renderStrip();
      break;
    default:
  }
}

// ─── Keep the free server awake during a session ─────────────────────────────
function pingHealth() {
  fetch(`${BACKEND_URL}/health`, { cache: "no-store" }).catch(() => {});
}
setInterval(() => {
  if (app.roomId) pingHealth();
}, KEEP_AWAKE_MS);

// ─── Start ───────────────────────────────────────────────────────────────────
// Start waking the server right away, even on the home page.
pingHealth();
route();
