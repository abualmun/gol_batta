# SyncVid — Full Project Context
> Handoff document for Claude Code. Contains the complete spec, all source code, deployment config, and deployment instructions.

---

## 1. Project Overview

**SyncVid** is a lightweight, web-based synchronized video player that lets two users watch the same local video file in real-time sync — without uploading anything to a server.

### Key design decisions
- **Local-first:** Video files never leave the user's device. JavaScript converts the file into a Blob URL via `URL.createObjectURL(file)`.
- **Zero database:** Room state is stored entirely in memory on the backend.
- **Free-tier hosted:** Frontend on Netlify (static), backend on Render (Node.js free tier).
- **Max 2 users per room.**
- **Anti-skip drift correction:** When playback drifts > 1.5s, the *advanced* player is always snapped *backward* — never skip content forward.

### Architecture
```
[User A Browser]                    [User B Browser]
  index.html                          index.html
  Socket.io client  <──WebSocket──>  Socket.io client
        |                                  |
        └──────────── Render ──────────────┘
                   server.js
               (Socket.io server)
                  in-memory rooms
```

---

## 2. File Structure

```
syncvid-backend/
├── server.js          ← Node.js + Socket.io signaling server
├── package.json
├── render.yaml        ← Render auto-deploy config
└── README.md

syncvid-frontend/
├── index.html         ← Entire frontend (single file)
├── netlify.toml       ← Redirect rules for /room/:id routing
└── README.md
```

---

## 3. Original Specification

### UI States
```
[ State 1: Server Wakeup ] ──> [ State 2: Setup Screen ] ──> [ State 3: Theater Mode ]
(Spinner + Render notice)       (File picker + Room URL)     (Video player + Log panel)
```

### Theater Mode Layout
```
+-----------------------------------------------------------------------+
|  [!] Warning: Video files do not match! (Conditional Banner)          |
+-------------------------------------------------------------+---------+
|                                                             |         |
|                                                             |ACTIVITY |
|                                                             |  LOG    |
|                      HTML5 VIDEO PLAYER                     |         |
|                                                             | > Joined|
|                                                             | > Paused|
|                                                             | > Sync'd|
+-------------------------------------------------------------+---------+
|  Room: [abcd-1234]  ● Partner online        [Copy Room Link]          |
+-----------------------------------------------------------------------+
```

### WebSocket Events

**Client → Server**
| Event | Payload |
|---|---|
| `room:join` | `{ roomId: string }` |
| `video:hash` | `{ hash: string }` (SHA-256 hex, 64 chars) |
| `video:state` | `{ status: "playing"\|"paused"\|"seeking", timestamp: number }` |
| `video:drift_ping` | `{ timestamp: number }` |

**Server → Client**
| Event | Payload |
|---|---|
| `room:joined` | `{ roomId, peerCount, isFirstInRoom }` |
| `room:full` | `{ message }` |
| `room:peer_joined` | `{ peerCount }` |
| `room:peer_left` | `{ peerCount }` |
| `video:hash_result` | `{ match: boolean, message: string }` |
| `video:state` | `{ status, timestamp }` |
| `video:state_sync` | `{ status, timestamp }` ← sent to late joiners |
| `video:drift_pong` | `{ timestamp, sentAt }` |

### Core sync logic
- **File hashing:** SHA-256 of first 20 MB of the file (sample, not full file — avoids freezing on GB+ files). Both users' hashes are compared server-side. Mismatch shows a warning banner but does NOT block playback.
- **State sync:** `play`, `pause`, `seeked` events on the video element are captured and broadcast via `video:state`. Remote events are applied with an `isSyncing` lock to prevent echo loops.
- **Drift monitor:** Every 5 seconds, each client sends `video:drift_ping` with its current timestamp. The peer receives a `video:drift_pong` and computes the drift. If drift > 1.5s and the local player is **ahead**, it snaps backward. If the local player is behind, it does nothing — the peer will detect it on their end.

---

## 4. Configuration

There is **one value** that must be updated before deploying the frontend:

In `syncvid-frontend/index.html`, find this line near the top of the `<script>` block:

```javascript
const BACKEND_URL = "https://YOUR-SYNCVID-SERVER.onrender.com"; // ← change this
```

Replace with the actual Render URL after deploying the backend.

Other tunable constants (same file):
```javascript
const DRIFT_THRESHOLD_S = 1.5;        // seconds of drift before correction
const DRIFT_CHECK_INTERVAL_MS = 5000; // how often to check drift
const HASH_SAMPLE_BYTES = 20 * 1024 * 1024; // 20 MB file sample for hashing
```

---

## 5. Source Code

### 5.1 `syncvid-backend/package.json`

```json
{
  "name": "syncvid-backend",
  "version": "1.0.0",
  "description": "SyncVid WebSocket signaling server",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2",
    "cors": "^2.8.5"
  }
}
```

### 5.2 `syncvid-backend/render.yaml`

```yaml
services:
  - type: web
    name: syncvid-server
    runtime: node
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: NODE_ENV
        value: production
    healthCheckPath: /health
```

### 5.3 `syncvid-backend/server.js`

```javascript
/**
 * SyncVid — Signaling & Room Coordinator
 * Render Free Tier compatible. Stateless rooms stored in memory.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Replace with your Netlify URL in production: "https://your-site.netlify.app"
    methods: ["GET", "POST"],
  },
});

// In-memory room state
// Structure: { [roomId]: { sockets: Set<string>, hashes: Map<socketId, hash>, state: { status, timestamp, updatedAt } } }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      sockets: new Set(),
      hashes: new Map(),
      state: null,
    });
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.sockets.size === 0) {
    rooms.delete(roomId);
    console.log(`[Room] Cleaned up empty room: ${roomId}`);
  }
}

// Health check endpoint (also used by Render's health monitor)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: rooms.size,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

app.get("/", (req, res) => {
  res.json({ service: "SyncVid Signaling Server", version: "1.0.0" });
});

io.on("connection", (socket) => {
  console.log(`[Connect] Socket: ${socket.id}`);
  let currentRoomId = null;

  // ─── Join Room ────────────────────────────────────────────────────────────
  socket.on("room:join", ({ roomId }) => {
    if (!roomId || typeof roomId !== "string") return;

    // Sanitize roomId
    const sanitizedRoomId = roomId.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64);
    if (!sanitizedRoomId) return;

    currentRoomId = sanitizedRoomId;
    const room = getOrCreateRoom(sanitizedRoomId);

    // Max 2 users per room
    if (room.sockets.size >= 2) {
      socket.emit("room:full", { message: "This room already has 2 participants." });
      return;
    }

    room.sockets.add(socket.id);
    socket.join(sanitizedRoomId);

    const peerCount = room.sockets.size;
    console.log(`[Room:${sanitizedRoomId}] ${socket.id} joined. Members: ${peerCount}`);

    // Notify the joining socket
    socket.emit("room:joined", {
      roomId: sanitizedRoomId,
      peerCount,
      isFirstInRoom: peerCount === 1,
    });

    // Notify others in the room
    socket.to(sanitizedRoomId).emit("room:peer_joined", {
      peerCount,
    });

    // If the room already has a video state, send it to the new joiner
    if (room.state) {
      let adjustedTimestamp = room.state.timestamp;
      if (room.state.status === "playing") {
        const elapsed = (Date.now() - room.state.updatedAt) / 1000;
        adjustedTimestamp = room.state.timestamp + elapsed;
      }
      socket.emit("video:state_sync", {
        status: room.state.status,
        timestamp: adjustedTimestamp,
      });
    }
  });

  // ─── Video Hash Verification ──────────────────────────────────────────────
  socket.on("video:hash", ({ hash }) => {
    if (!currentRoomId) return;
    if (typeof hash !== "string" || hash.length !== 64) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.hashes.set(socket.id, hash);
    console.log(`[Room:${currentRoomId}] Hash received from ${socket.id}`);

    if (room.hashes.size === 2) {
      const hashValues = Array.from(room.hashes.values());
      const match = hashValues[0] === hashValues[1];

      io.to(currentRoomId).emit("video:hash_result", {
        match,
        message: match
          ? "Video files verified. Files match."
          : "Warning: Video files do not match. Syncing may be inaccurate.",
      });

      console.log(`[Room:${currentRoomId}] Hash comparison: ${match ? "MATCH" : "MISMATCH"}`);
    }
  });

  // ─── Video State Sync ─────────────────────────────────────────────────────
  socket.on("video:state", ({ status, timestamp }) => {
    if (!currentRoomId) return;
    if (!["playing", "paused", "seeking"].includes(status)) return;
    if (typeof timestamp !== "number" || timestamp < 0) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.state = { status, timestamp, updatedAt: Date.now() };

    socket.to(currentRoomId).emit("video:state", {
      status,
      timestamp,
    });

    console.log(`[Room:${currentRoomId}] State from ${socket.id}: ${status} @ ${timestamp.toFixed(2)}s`);
  });

  // ─── Drift Sync Request ───────────────────────────────────────────────────
  socket.on("video:drift_ping", ({ timestamp }) => {
    if (!currentRoomId) return;
    if (typeof timestamp !== "number") return;

    socket.to(currentRoomId).emit("video:drift_pong", {
      timestamp,
      sentAt: Date.now(),
    });
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[Disconnect] Socket: ${socket.id} — Reason: ${reason}`);

    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.sockets.delete(socket.id);
        room.hashes.delete(socket.id);

        socket.to(currentRoomId).emit("room:peer_left", {
          peerCount: room.sockets.size,
        });

        console.log(`[Room:${currentRoomId}] ${socket.id} left. Members: ${room.sockets.size}`);
        cleanupRoom(currentRoomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎬 SyncVid Signaling Server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
```

### 5.4 `syncvid-frontend/netlify.toml`

```toml
[[redirects]]
  from = "/room/*"
  to = "/index.html"
  status = 200
```

### 5.5 `syncvid-frontend/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SyncVid — Watch Together</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.min.js"></script>
  <style>
    /* ── Design Tokens ───────────────────────────────────────────────────── */
    :root {
      --bg:           #0a0a0f;
      --surface:      #111118;
      --surface-2:    #1a1a25;
      --border:       #2a2a3a;
      --border-light: #3a3a50;
      --accent:       #7c6af7;
      --accent-glow:  rgba(124, 106, 247, 0.18);
      --accent-dim:   rgba(124, 106, 247, 0.35);
      --warn:         #f7a76a;
      --warn-bg:      rgba(247, 167, 106, 0.1);
      --success:      #6af7a7;
      --success-bg:   rgba(106, 247, 167, 0.1);
      --danger:       #f76a7a;
      --text:         #e8e8f0;
      --text-dim:     #888899;
      --text-muted:   #555566;
      --radius:       10px;
      --radius-sm:    6px;
      --font-mono:    'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
      --font-ui:      'Inter', system-ui, -apple-system, sans-serif;
      --transition:   0.18s ease;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-ui);
      font-size: 14px;
      line-height: 1.5;
      overflow: hidden;
    }

    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 2px; }

    .state { display: none; height: 100vh; width: 100vw; }
    .state.active { display: flex; }

    /* STATE 1: Wakeup */
    #state-wakeup {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 28px;
      background: radial-gradient(ellipse 60% 50% at 50% 50%, rgba(124,106,247,0.06) 0%, transparent 70%);
    }
    .wakeup-logo { font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.25em; color: var(--accent); text-transform: uppercase; opacity: 0.7; }
    .wakeup-spinner { width: 40px; height: 40px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .wakeup-title { font-size: 18px; font-weight: 500; color: var(--text); }
    .wakeup-subtitle { font-size: 13px; color: var(--text-dim); text-align: center; max-width: 320px; line-height: 1.7; }
    .wakeup-bar-wrap { width: 240px; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
    .wakeup-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #a78bfa); border-radius: 2px; animation: loading-bar 50s linear forwards; width: 0%; }
    @keyframes loading-bar { to { width: 95%; } }

    /* STATE 2: Setup */
    #state-setup { flex-direction: column; align-items: center; justify-content: center; gap: 0; background: radial-gradient(ellipse 70% 60% at 50% 40%, rgba(124,106,247,0.07) 0%, transparent 70%); }
    .setup-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 44px 48px; width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 28px; }
    .setup-header { display: flex; flex-direction: column; gap: 8px; }
    .logo-mark { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.3em; color: var(--accent); text-transform: uppercase; }
    .setup-title { font-size: 26px; font-weight: 600; color: var(--text); letter-spacing: -0.02em; }
    .setup-desc { font-size: 13px; color: var(--text-dim); line-height: 1.65; }
    .divider { height: 1px; background: var(--border); }
    .room-status { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-dim); }
    .room-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
    .room-status-dot.connected { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .room-status-dot.waiting { background: var(--warn); animation: pulse-dot 1.4s ease-in-out infinite; }
    .room-status-dot.paired { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
    @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .url-group { display: flex; flex-direction: column; gap: 8px; }
    .url-label { font-size: 11px; font-family: var(--font-mono); letter-spacing: 0.1em; color: var(--text-muted); text-transform: uppercase; }
    .url-row { display: flex; gap: 8px; }
    .url-input { flex: 1; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); cursor: default; user-select: all; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 18px; border-radius: var(--radius-sm); border: none; font-family: var(--font-ui); font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity var(--transition), transform var(--transition), background var(--transition); white-space: nowrap; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover:not(:disabled) { opacity: 0.88; }
    .btn-ghost { background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border); }
    .btn-ghost:hover:not(:disabled) { background: var(--border); color: var(--text); }
    .btn-icon { padding: 10px 12px; }
    .file-zone { position: relative; border: 1.5px dashed var(--border-light); border-radius: var(--radius); padding: 28px; text-align: center; cursor: pointer; transition: border-color var(--transition), background var(--transition); display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .file-zone:hover, .file-zone.drag-over { border-color: var(--accent); background: var(--accent-glow); }
    .file-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .file-icon { font-size: 28px; line-height: 1; }
    .file-zone-label { font-size: 13px; color: var(--text-dim); }
    .file-zone-label strong { color: var(--accent); }
    .file-selected-name { font-family: var(--font-mono); font-size: 12px; color: var(--success); background: var(--success-bg); padding: 4px 10px; border-radius: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hashing-indicator { display: none; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
    .hashing-indicator.visible { display: flex; }
    .mini-spinner { width: 12px; height: 12px; border: 1.5px solid var(--border-light); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
    .setup-actions { display: flex; gap: 10px; }
    .setup-actions .btn { flex: 1; justify-content: center; }

    /* STATE 3: Theater */
    #state-theater { flex-direction: column; overflow: hidden; }
    .mismatch-banner { display: none; align-items: center; gap: 12px; padding: 10px 20px; background: var(--warn-bg); border-bottom: 1px solid rgba(247, 167, 106, 0.2); font-size: 13px; color: var(--warn); flex-shrink: 0; }
    .mismatch-banner.visible { display: flex; }
    .mismatch-banner svg { flex-shrink: 0; }
    .theater-body { flex: 1; display: flex; overflow: hidden; }
    .video-area { flex: 1; display: flex; flex-direction: column; background: #000; position: relative; }
    #video-player { flex: 1; width: 100%; object-fit: contain; background: #000; display: block; }
    .pick-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .pick-overlay.hidden { display: none; }
    .pick-btn-large { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 36px 48px; border: 1.5px dashed var(--border-light); border-radius: 16px; cursor: pointer; transition: all var(--transition); position: relative; }
    .pick-btn-large:hover { border-color: var(--accent); background: var(--accent-glow); }
    .pick-btn-large input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .pick-btn-large .file-icon { font-size: 40px; opacity: 0.5; }
    .pick-btn-large .pick-label { font-size: 15px; color: var(--text-dim); font-weight: 500; }
    .pick-btn-large .pick-sub { font-size: 12px; color: var(--text-muted); }
    .theater-controls { flex-shrink: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 16px; }
    .room-pill { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 100px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; }
    .peer-badge { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .peer-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
    .peer-dot.online { background: var(--success); }
    .controls-spacer { flex: 1; }
    .copy-room-btn { font-size: 12px; }

    /* Activity Log */
    .log-panel { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--surface); }
    .log-header { padding: 14px 16px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .log-title { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--text-muted); text-transform: uppercase; }
    .log-count { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: var(--surface-2); padding: 2px 7px; border-radius: 10px; }
    .log-entries { flex: 1; overflow-y: auto; padding: 8px 0; display: flex; flex-direction: column; gap: 2px; }
    .log-entry { padding: 5px 16px; font-family: var(--font-mono); font-size: 11px; line-height: 1.55; border-left: 2px solid transparent; transition: background var(--transition); animation: fadeInUp 0.2s ease; }
    .log-entry:hover { background: var(--surface-2); }
    .log-entry.system  { color: var(--text-muted); border-left-color: var(--border); }
    .log-entry.partner { color: #a78bfa; border-left-color: #a78bfa; }
    .log-entry.you     { color: var(--accent); border-left-color: var(--accent); }
    .log-entry.warn    { color: var(--warn); border-left-color: var(--warn); }
    .log-entry.success { color: var(--success); border-left-color: var(--success); }
    .log-entry .tag { opacity: 0.6; margin-right: 4px; }
    .log-entry .ts { opacity: 0.35; font-size: 9px; margin-left: 4px; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Toast */
    .toast-container { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 9999; pointer-events: none; }
    .toast { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; background: var(--surface-2); border: 1px solid var(--border-light); color: var(--text); white-space: nowrap; animation: toast-in 0.25s ease, toast-out 0.25s ease 2.5s forwards; pointer-events: auto; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes toast-out { to { opacity: 0; transform: translateY(4px); } }

    @media (max-width: 700px) {
      .log-panel { display: none; }
      .setup-card { padding: 28px 24px; margin: 0 16px; }
    }
  </style>
</head>
<body>

<!-- STATE 1: Wakeup -->
<div id="state-wakeup" class="state active">
  <span class="wakeup-logo">SyncVid</span>
  <div class="wakeup-spinner"></div>
  <div class="wakeup-title">Connecting to server…</div>
  <div class="wakeup-subtitle">
    The server is waking up from sleep — this takes about 50 seconds on the free tier.
  </div>
  <div class="wakeup-bar-wrap">
    <div class="wakeup-bar" id="wakeup-bar"></div>
  </div>
</div>

<!-- STATE 2: Setup -->
<div id="state-setup" class="state">
  <div class="setup-card">
    <div class="setup-header">
      <span class="logo-mark">SyncVid</span>
      <h1 class="setup-title">Watch together, in sync.</h1>
      <p class="setup-desc">Play any local video file in perfect sync with a friend — no uploads, no accounts.</p>
    </div>
    <div class="divider"></div>
    <div class="room-status" id="room-status-indicator">
      <div class="room-status-dot" id="setup-status-dot"></div>
      <span id="setup-status-text">Joining room…</span>
    </div>
    <div class="url-group">
      <span class="url-label">Room link — share this with your partner</span>
      <div class="url-row">
        <input class="url-input" id="room-url-display" type="text" readonly value="…" />
        <button class="btn btn-ghost btn-icon" id="copy-url-btn" title="Copy link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="file-zone" id="setup-file-zone">
      <input type="file" id="setup-file-input" accept="video/*" />
      <div class="file-icon">🎬</div>
      <div class="file-zone-label">
        <strong>Click to choose</strong> your video file<br>
        <span style="font-size:12px;color:var(--text-muted)">or drag it here · never uploaded</span>
      </div>
      <div id="setup-file-name" style="display:none" class="file-selected-name"></div>
    </div>
    <div class="hashing-indicator" id="hashing-indicator">
      <div class="mini-spinner"></div>
      <span>Computing file fingerprint…</span>
    </div>
    <div class="setup-actions">
      <button class="btn btn-primary" id="enter-theater-btn" disabled>Enter Theater</button>
    </div>
  </div>
</div>

<!-- STATE 3: Theater -->
<div id="state-theater" class="state">
  <div class="mismatch-banner" id="mismatch-banner">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    Warning: Video files do not match. Syncing may be inaccurate.
  </div>
  <div class="theater-body">
    <div class="video-area">
      <video id="video-player" controls></video>
      <div class="pick-overlay" id="theater-pick-overlay">
        <label class="pick-btn-large">
          <input type="file" id="theater-file-input" accept="video/*" />
          <div class="file-icon">📂</div>
          <div class="pick-label">Open your video file</div>
          <div class="pick-sub">Never uploaded · stays on your device</div>
        </label>
      </div>
    </div>
    <div class="log-panel">
      <div class="log-header">
        <span class="log-title">Activity Log</span>
        <span class="log-count" id="log-count">0</span>
      </div>
      <div class="log-entries" id="log-entries"></div>
    </div>
  </div>
  <div class="theater-controls">
    <div class="room-pill" id="theater-room-pill">
      <span style="color:var(--accent)">⬡</span>
      <span id="theater-room-id">—</span>
    </div>
    <div class="peer-badge">
      <div class="peer-dot" id="peer-dot"></div>
      <span id="peer-status-text">Partner offline</span>
    </div>
    <div class="controls-spacer"></div>
    <button class="btn btn-ghost copy-room-btn" id="theater-copy-btn">Copy Room Link</button>
  </div>
</div>

<div class="toast-container" id="toast-container"></div>

<script>
  const BACKEND_URL = "https://YOUR-SYNCVID-SERVER.onrender.com"; // ← UPDATE THIS
  const DRIFT_THRESHOLD_S = 1.5;
  const DRIFT_CHECK_INTERVAL_MS = 5000;
  const HASH_SAMPLE_BYTES = 20 * 1024 * 1024;

  let socket = null;
  let roomId = null;
  let peerOnline = false;
  let videoFile = null;
  let fileHash = null;
  let isSyncing = false;
  let peerTimestamp = null;
  let driftInterval = null;
  let logEntryCount = 0;

  const el = {
    stateWakeup:         document.getElementById("state-wakeup"),
    stateSetup:          document.getElementById("state-setup"),
    stateTheater:        document.getElementById("state-theater"),
    setupStatusDot:      document.getElementById("setup-status-dot"),
    setupStatusText:     document.getElementById("setup-status-text"),
    roomUrlDisplay:      document.getElementById("room-url-display"),
    copyUrlBtn:          document.getElementById("copy-url-btn"),
    setupFileZone:       document.getElementById("setup-file-zone"),
    setupFileInput:      document.getElementById("setup-file-input"),
    setupFileName:       document.getElementById("setup-file-name"),
    hashingIndicator:    document.getElementById("hashing-indicator"),
    enterTheaterBtn:     document.getElementById("enter-theater-btn"),
    mismatchBanner:      document.getElementById("mismatch-banner"),
    videoPlayer:         document.getElementById("video-player"),
    theaterPickOverlay:  document.getElementById("theater-pick-overlay"),
    theaterFileInput:    document.getElementById("theater-file-input"),
    logEntries:          document.getElementById("log-entries"),
    logCount:            document.getElementById("log-count"),
    theaterRoomPill:     document.getElementById("theater-room-pill"),
    theaterRoomId:       document.getElementById("theater-room-id"),
    peerDot:             document.getElementById("peer-dot"),
    peerStatusText:      document.getElementById("peer-status-text"),
    theaterCopyBtn:      document.getElementById("theater-copy-btn"),
    toastContainer:      document.getElementById("toast-container"),
  };

  function showState(name) {
    document.querySelectorAll(".state").forEach(s => s.classList.remove("active"));
    document.getElementById("state-" + name).classList.add("active");
  }

  function toast(msg, duration = 2800) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    el.toastContainer.appendChild(t);
    setTimeout(() => t.remove(), duration);
  }

  function formatTime(s) {
    if (isNaN(s)) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }

  function addLog(type, message) {
    logEntryCount++;
    el.logCount.textContent = logEntryCount;
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    const tagMap = { system: "[System]", you: "[You]", partner: "[Partner]", warn: "[Warning]", success: "[System]" };
    entry.innerHTML = `<span class="tag">${tagMap[type] || "[Log]"}</span>${message}<span class="ts">${nowHHMM()}</span>`;
    el.logEntries.appendChild(entry);
    el.logEntries.scrollTop = el.logEntries.scrollHeight;
  }

  function generateRoomId() {
    return Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function getRoomIdFromURL() {
    const parts = window.location.pathname.split("/");
    const idx = parts.indexOf("room");
    return (idx !== -1 && parts[idx + 1]) ? parts[idx + 1] : null;
  }

  function buildRoomURL(rid) {
    return `${window.location.origin}/room/${rid}`;
  }

  function copyRoomLink() {
    const url = buildRoomURL(roomId);
    navigator.clipboard.writeText(url).then(() => toast("Room link copied!"));
  }

  async function hashFileSample(file) {
    const sample = file.slice(0, Math.min(HASH_SAMPLE_BYTES, file.size));
    const buffer = await sample.arrayBuffer();
    const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function handleFileSelect(file) {
    if (!file || !file.type.startsWith("video/")) { toast("Please select a valid video file."); return; }
    videoFile = file;
    el.setupFileName.textContent = file.name;
    el.setupFileName.style.display = "block";
    el.hashingIndicator.classList.add("visible");
    el.enterTheaterBtn.disabled = true;
    try {
      fileHash = await hashFileSample(file);
      el.hashingIndicator.classList.remove("visible");
      el.enterTheaterBtn.disabled = false;
      toast("File ready — enter the theater!");
    } catch (e) {
      el.hashingIndicator.classList.remove("visible");
      toast("Error reading file. Please try again.");
    }
  }

  el.setupFileInput.addEventListener("change", e => { if (e.target.files[0]) handleFileSelect(e.target.files[0]); });
  el.setupFileZone.addEventListener("dragover", e => { e.preventDefault(); el.setupFileZone.classList.add("drag-over"); });
  el.setupFileZone.addEventListener("dragleave", () => { el.setupFileZone.classList.remove("drag-over"); });
  el.setupFileZone.addEventListener("drop", e => { e.preventDefault(); el.setupFileZone.classList.remove("drag-over"); const file = e.dataTransfer.files[0]; if (file) handleFileSelect(file); });
  el.theaterFileInput.addEventListener("change", e => { const file = e.target.files[0]; if (!file || !file.type.startsWith("video/")) return; loadVideoFile(file); });

  function loadVideoFile(file) {
    videoFile = file;
    const blobUrl = URL.createObjectURL(file);
    el.videoPlayer.src = blobUrl;
    el.theaterPickOverlay.classList.add("hidden");
    addLog("system", `Loaded: ${file.name}`);
    if (!fileHash) {
      hashFileSample(file).then(hash => {
        fileHash = hash;
        if (socket && socket.connected) { socket.emit("video:hash", { hash }); addLog("system", "File fingerprint sent to server."); }
      });
    } else {
      if (socket && socket.connected) { socket.emit("video:hash", { hash: fileHash }); addLog("system", "File fingerprint sent to server."); }
    }
  }

  el.enterTheaterBtn.addEventListener("click", () => {
    showState("theater");
    el.theaterRoomId.textContent = roomId;
    if (videoFile) loadVideoFile(videoFile);
    startDriftMonitor();
    addLog("system", "Entered theater mode.");
  });

  function emitState(status) {
    if (!socket || !socket.connected) return;
    socket.emit("video:state", { status, timestamp: el.videoPlayer.currentTime });
  }

  el.videoPlayer.addEventListener("play", () => { if (isSyncing) return; emitState("playing"); addLog("you", `Resumed at ${formatTime(el.videoPlayer.currentTime)}`); });
  el.videoPlayer.addEventListener("pause", () => { if (isSyncing) return; emitState("paused"); addLog("you", `Paused at ${formatTime(el.videoPlayer.currentTime)}`); });
  el.videoPlayer.addEventListener("seeked", () => { if (isSyncing) return; const status = el.videoPlayer.paused ? "paused" : "seeking"; emitState(status); addLog("you", `Seeked to ${formatTime(el.videoPlayer.currentTime)}`); });

  function applyRemoteState(status, timestamp) {
    isSyncing = true;
    peerTimestamp = timestamp;
    const player = el.videoPlayer;
    if (Math.abs(player.currentTime - timestamp) > 0.4) player.currentTime = timestamp;
    if (status === "playing") player.play().catch(() => {});
    else if (status === "paused" || status === "seeking") { player.pause(); player.currentTime = timestamp; }
    setTimeout(() => { isSyncing = false; }, 300);
  }

  function startDriftMonitor() {
    if (driftInterval) clearInterval(driftInterval);
    driftInterval = setInterval(() => {
      if (!peerOnline || !socket || !socket.connected) return;
      if (el.videoPlayer.paused || !el.videoPlayer.src) return;
      socket.emit("video:drift_ping", { timestamp: el.videoPlayer.currentTime });
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  function initSocket() {
    addLog("system", "Connecting to server…");
    socket = io(BACKEND_URL, { reconnectionAttempts: 10, reconnectionDelay: 2000, timeout: 60000 });

    socket.on("connect", () => {
      if (document.getElementById("state-wakeup").classList.contains("active")) showState("setup");
      socket.emit("room:join", { roomId });
      el.setupStatusDot.className = "room-status-dot connected";
      el.setupStatusText.textContent = "Connected — waiting for partner…";
      addLog("system", "Connected to server.");
    });

    socket.on("room:joined", ({ isFirstInRoom }) => {
      el.roomUrlDisplay.value = buildRoomURL(roomId);
      if (isFirstInRoom) {
        el.setupStatusDot.className = "room-status-dot waiting";
        el.setupStatusText.textContent = "Waiting for your partner to join…";
        addLog("system", "Room created. Share the link above.");
      } else {
        el.setupStatusDot.className = "room-status-dot paired";
        el.setupStatusText.textContent = "Partner is in the room!";
        peerOnline = true;
        updatePeerStatus(true);
        addLog("success", "Your partner is already in the room.");
      }
    });

    socket.on("room:full", ({ message }) => {
      el.setupStatusDot.className = "room-status-dot";
      el.setupStatusText.textContent = message;
      toast("Room is full. Create a new room.");
      addLog("warn", message);
    });

    socket.on("room:peer_joined", () => {
      peerOnline = true;
      el.setupStatusDot.className = "room-status-dot paired";
      el.setupStatusText.textContent = "Partner joined — ready to watch!";
      updatePeerStatus(true);
      addLog("partner", "Joined the room.");
      toast("🎬 Your partner joined!");
      if (fileHash) socket.emit("video:hash", { hash: fileHash });
    });

    socket.on("room:peer_left", () => {
      peerOnline = false;
      peerTimestamp = null;
      el.setupStatusDot.className = "room-status-dot waiting";
      el.setupStatusText.textContent = "Waiting for your partner to rejoin…";
      updatePeerStatus(false);
      addLog("warn", "Partner left the room.");
      toast("Partner disconnected.");
    });

    socket.on("video:hash_result", ({ match }) => {
      if (match) { el.mismatchBanner.classList.remove("visible"); addLog("success", "Video files verified — files match."); toast("✓ Video files match"); }
      else { el.mismatchBanner.classList.add("visible"); addLog("warn", "Video files do not match. Sync may be off."); toast("⚠ Files don't match!"); }
    });

    socket.on("video:state", ({ status, timestamp }) => {
      if (!el.videoPlayer.src) { addLog("partner", `${capitalize(status)} (no file loaded yet)`); return; }
      applyRemoteState(status, timestamp);
      const actionMap = { playing: "Resumed", paused: "Paused", seeking: "Seeked" };
      addLog("partner", `${actionMap[status] || status} at ${formatTime(timestamp)}`);
    });

    socket.on("video:state_sync", ({ status, timestamp }) => {
      if (!el.videoPlayer.src) return;
      applyRemoteState(status, timestamp);
      addLog("system", `Synced to room state: ${capitalize(status)} at ${formatTime(timestamp)}`);
    });

    socket.on("video:drift_pong", ({ timestamp, sentAt }) => {
      if (!el.videoPlayer.src || el.videoPlayer.paused) return;
      const latency = (Date.now() - sentAt) / 1000;
      const peerNow = timestamp + latency;
      const ourNow = el.videoPlayer.currentTime;
      const drift = ourNow - peerNow;
      if (Math.abs(drift) > DRIFT_THRESHOLD_S && drift > 0) {
        isSyncing = true;
        el.videoPlayer.currentTime = peerNow;
        setTimeout(() => { isSyncing = false; }, 300);
        addLog("system", `Drift detected (+${drift.toFixed(1)}s). Snapped back to sync.`);
      }
    });

    socket.on("disconnect", (reason) => { addLog("warn", `Disconnected: ${reason}. Reconnecting…`); updatePeerStatus(false); });
    socket.on("reconnect", (attempt) => { addLog("system", `Reconnected after ${attempt} attempt(s).`); socket.emit("room:join", { roomId }); });
    socket.on("connect_error", (err) => { console.warn("Connect error:", err.message); });
  }

  function updatePeerStatus(online) {
    peerOnline = online;
    el.peerDot.className = "peer-dot" + (online ? " online" : "");
    el.peerStatusText.textContent = online ? "Partner online" : "Partner offline";
  }

  function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

  el.copyUrlBtn.addEventListener("click", copyRoomLink);
  el.theaterCopyBtn.addEventListener("click", () => { copyRoomLink(); toast("Room link copied!"); });

  function init() {
    const existingRoomId = getRoomIdFromURL();
    if (existingRoomId) {
      roomId = existingRoomId;
    } else {
      roomId = generateRoomId();
      window.history.replaceState({}, "", `/room/${roomId}`);
    }
    el.roomUrlDisplay.value = buildRoomURL(roomId);
    el.theaterRoomId.textContent = roomId;
    showState("wakeup");
    addLog("system", "Connecting to server…");
    initSocket();
  }

  init();
</script>
</body>
</html>
```

---

## 6. Deployment Instructions

### Step 1 — Deploy Backend to Render

1. Push `syncvid-backend/` to a GitHub repo
2. Go to [render.com](https://render.com) → **New +** → **Web Service**
3. Connect your GitHub repo
4. Set:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Deploy. Wait for the build log to show: `🎬 SyncVid Signaling Server running on port 3001`
6. Copy your Render URL: `https://syncvid-server.onrender.com`
7. Verify it works: visit `https://syncvid-server.onrender.com/health` — should return `{ "status": "ok" }`

### Step 2 — Update Frontend Config

In `syncvid-frontend/index.html`, find and update:
```javascript
const BACKEND_URL = "https://syncvid-server.onrender.com"; // ← your actual Render URL
```

### Step 3 — Deploy Frontend to Netlify

**Option A — Drag & Drop:**
1. Go to [netlify.com](https://netlify.com) → **Add new site** → **Deploy manually**
2. Drag the `syncvid-frontend/` folder into the drop zone
3. Done — live in ~10 seconds

**Option B — GitHub:**
1. Push `syncvid-frontend/` to GitHub
2. Netlify → **Add new site** → **Import from GitHub**
3. Set Publish directory to `.`
4. Deploy

The `netlify.toml` file handles the `/room/:id` URL routing automatically.

### Step 4 — Verify

1. Open your Netlify URL
2. You should see the wakeup screen briefly, then the setup screen
3. Open a second browser tab with the room URL to test pairing
4. Load the same video file in both tabs
5. Press play in one — the other should follow within milliseconds

---

## 7. Known Limitations & Potential Improvements

- **Free tier cold starts:** Render spins down after 15 min inactivity → ~50s wakeup delay (handled by the wakeup screen).
- **Memory-only rooms:** If the Render server restarts, all rooms are lost. Users must rejoin.
- **No room persistence:** Refreshing either browser tab requires re-joining and re-selecting the file.
- **CORS:** Currently set to `origin: "*"`. Lock this down to your Netlify URL in production.
- **Potential improvements:** Room reconnection flow, mobile UI improvements (log panel hidden on mobile), user-selectable drift threshold, volume sync.
