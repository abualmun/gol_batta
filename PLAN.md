# SyncVid — Project Plan (A → Z)

> Source spec: `SYNCVID_CONTEXT.md`. This plan keeps its core idea (local-first, no database,
> max 2 people, never skip content forward) and fixes the problems found in its reference code.

---

## 0. Decisions

| Topic | Decision | Who decided |
|---|---|---|
| Language | Plain JavaScript, no build step | You |
| Hosting | Render free (backend) + Netlify free (frontend) | You |
| Extra features | Nicknames, text chat, subtitles | You |
| UI language | English only | You |
| Folders | `syncvid-backend/` and `syncvid-frontend/`, fully separate, in **one git repo** | Default (Render and Netlify can each deploy one subfolder) |
| Frontend files | `index.html` + `css/` + `js/` ES modules (browsers load them natively, so there's no build step) | Default |
| Compatibility | One contract file, `PROTOCOL.md`, plus integration tests that run real frontend code against the real backend | Default |
| Theme | Dark by default, light when the device is set to light | Default (easy to change) |
| Socket.io client | A pinned copy kept in `syncvid-frontend/vendor/` instead of loading it from a CDN | Default (one fewer outside service that can fail) |

---

## 1. Problems found in the spec's reference code

All of these get fixed. They're listed so you know why the new code differs from the spec.

| # | Problem | Effect | Fix |
|---|---|---|---|
| 1 | The server records `currentRoomId` **before** it checks whether the room is full | A 3rd person who gets "room full" can still play, pause and seek the other two people's video | Set the room only after a successful join. Every handler checks membership. |
| 2 | Late joiners: `video:state_sync` is ignored when no file is loaded yet, and it always arrives before a file is loaded | The person who joins second never catches up | Keep the room state as "pending" and apply it as soon as the video's metadata loads |
| 3 | Seeking while playing sends `status: "seeking"`, and the receiver **pauses** on it | Every seek during playback pauses your partner | Replace the status with `seek` as an action that keeps the current play/pause state |
| 4 | Drift math mixes the server clock with the client clock and counts only half the network trip | Wrong drift on phones whose clocks are off, which means random snapping | Small clock sync on connect (like NTP) so every client converts to server time |
| 5 | Echo protection is a fixed 300 ms timer | On slow phones, `seeked` fires after 300 ms and the event echoes back, causing loops | Suppress events by expectation: ignore the specific event we triggered ourselves |
| 6 | `socket.on("reconnect")` sits on the wrong object in Socket.io v4 | Reconnect logging never fires (harmless, but misleading) | Handle everything in `connect`, which also fires after a reconnect |
| 7 | Mobile browsers block `play()` that a user didn't start | On iPhone, a remote "play" silently does nothing | Show a big **"Tap to sync"** button when play is blocked |
| 8 | Log text uses `innerHTML` with file names and server messages | Code injection risk | Use `textContent` everywhere; never insert HTML strings |
| 9 | Room IDs come from `Math.random`, 8 characters | Guessable, so strangers could join | `crypto.getRandomValues`, 10 characters from an alphabet without confusable letters |
| 10 | CORS allows any origin (`"*"`), no rate limits, default 1 MB message size | Easy to abuse | Origin allowlist from an environment variable, per-socket rate limits, 16 KB message size |
| 11 | `100vh` with `overflow: hidden` | On phones, the browser bars cover the bottom controls | Use `100dvh`, safe-area padding, and a layout built for phones first |
| 12 | Activity log hidden on phones (`display: none` under 700px) | Phone users can't see what's happening | Phone layout gets tabs (Chat / Activity) under the video |
| 13 | Files are rejected if `file.type` is empty | Some valid files (e.g. `.mkv` on some systems) can't even be tried | Accept by extension too; if the browser can't play the file, show a clear error |
| 14 | Opening the site auto-creates a room, with no "join a room" path | Confusing; a refresh can land you in a fresh room | Home screen with **Create room** and **Join room** |

---

## 2. Repository layout (as built)

```
gol_batta/
├── PLAN.md · PROTOCOL.md · README.md · SYNCVID_CONTEXT.md
├── render.yaml                ← Render Blueprint (must sit at the repo root; rootDir → syncvid-backend)
├── netlify.toml               ← Netlify config (base syncvid-frontend, publish public/, CSP + headers)
│
├── syncvid-backend/
│   ├── server.js              ← entry: listen + graceful SIGTERM shutdown
│   ├── src/  app.js · handlers.js · rooms.js · validate.js · rateLimit.js · origins.js · config.js
│   └── test/ units.test.js · protocol.test.js
│
└── syncvid-frontend/
    ├── public/                ← the ONLY folder that gets published
    │   ├── index.html · css/styles.css · assets/ (icon, self-hosted fonts) · vendor/socket.io.min.js
    │   └── js/  main.js · connection.js · sync.js · panel.js · subtitles.js · subtitles-parse.js
    │            hash.js · ids.js · ui.js · config.js
    ├── tests/ unit/ (node:test) · e2e/ (Playwright) · fixtures/ (test videos, .srt)
    ├── playwright.config.js   ← 5 device projects; starts its own servers on 3101/5174/5175
    └── serve.json             ← local dev server: /room/* rewrite, no directory listing
```

Changes from the first draft, and why:
- `render.yaml` and `netlify.toml` live at the repo root, because both services read them from there.
- Site files moved into `public/` so `node_modules`, tests and fixtures are never published.
- The frontend pings `/health` every 5 min during a session, so Render's free plan doesn't
  put the server to sleep mid-film.
- A unit test checks that the backend URL in `config.js` and the CSP in `netlify.toml` match,
  and an end-to-end test runs the app under the real production CSP.

---

## 3. The protocol (summary — the full version goes in `PROTOCOL.md`)

Every payload is validated on the server. Invalid messages are dropped silently and logged.
All times are **server time in milliseconds** (each client converts with its clock offset, see §4).

### Client → Server

| Event | Payload | Rules |
|---|---|---|
| `time:ping` | `{ t0 }` | For clock sync. Replies with `time:pong`. |
| `room:join` | `{ roomId, name }` | roomId: 4–32 chars `[a-z0-9-]`. name: 1–24 chars, trimmed, no control chars. |
| `room:leave` | `{}` | Explicit leave (e.g. "Leave room" button). |
| `video:hash` | `{ hash, fileName, duration }` | hash = 64 hex chars. fileName ≤ 200 chars (shown to the partner). |
| `video:control` | `{ action: "play" \| "pause" \| "seek", position }` | position ≥ 0, finite. Rate limit: 10/s. |
| `video:report` | `{ position, playing }` | Sent every 3s while in the theater, used for drift. Rate limit: 2/s. |
| `chat:send` | `{ text }` | 1–500 chars after trim. Rate limit: 5 per 5s. |

### Server → Client

| Event | Payload |
|---|---|
| `time:pong` | `{ t0, serverTime }` |
| `room:joined` | `{ roomId, you: {id, name}, peer: {id, name} \| null, state, chat: [...last 50] }` |
| `room:full` | `{ message }` |
| `room:error` | `{ code, message }` (bad id, bad name, rate limited) |
| `room:peer_joined` | `{ peer: {id, name} }` |
| `room:peer_left` | `{ peerId }` |
| `video:hash_result` | `{ match, yourFile, peerFile }` |
| `video:state` | `{ playing, position, updatedAt, by: name, action, seq }` — sent to **both** clients |
| `video:peer_report` | `{ position, playing, at }` |
| `chat:message` | `{ id, from: name, text, at }` |

**Key rule:** the server holds the one true room state `{ playing, position, updatedAt, seq }`.
Clients send *requests* (`video:control`). The server updates the state and broadcasts it to
everyone, including the sender. The sender recognises its own `seq` and doesn't re-apply it. Two people pressing
buttons at the same moment can't make the players disagree: the last request the server
receives wins on both screens.

---

## 4. Sync engine (the heart of the app)

1. **Clock sync.** On connect, send 5 `time:ping`s, take the reply with the lowest round-trip
   time, `offset = serverTime − (t0 + t1)/2`. Repeat every 60s. `serverNow() = Date.now() + offset`.
2. **Applying state.** Expected position = `position + (serverNow() − updatedAt)/1000` if playing.
   Seek only if we're off by more than 0.5s (avoids micro-stutters), then play or pause.
3. **Echo guard.** Before changing the player in code, record what we expect
   (`{ type: "seeked", near: 42.0 }`). When the matching event fires, swallow it.
   Expectations expire after 3s so one missing event can't block the user.
4. **Drift (anti-skip rule kept).** Every 3s each client sends `video:report`. When a peer report
   arrives: `peerNow = position + (serverNow() − at)/1000`. If **I am ahead** by more than 1.5s,
   seek **back** to `peerNow`. If I'm behind, do nothing; my partner's client will pull back.
   Nobody ever jumps forward over content.
5. **Late join / file picked later.** The `state` from `room:joined` is stored as pending and
   applied on `loadedmetadata`.
6. **Autoplay blocked (phones).** If `play()` is rejected, show a full-size "Tap to sync" button.
   Tapping it plays from the correct position.
7. **Buffering.** If my video stalls (`waiting`) the partner keeps going; drift correction pulls
   them back when I resume. (Auto-pausing both people on buffering is a possible later feature.)
8. **Reconnect.** Socket.io reconnects automatically. On every `connect`, re-run clock sync and
   `room:join` with the same name, then apply the returned state. If the server lost the room
   (restart) and returns no state, the rejoining client re-seeds it with a `video:control` from its
   own player. Phones locking the screen and coming back are handled by the same path.

---

## 5. Backend plan

- **Room store** (`rooms.js`): `Map<roomId, { members: Map<socketId,{name}>, hashes, state, chat[], lastActive }>`.
  Pure functions (`join`, `leave`, `setState`, `addChat`), so they can be unit-tested without sockets.
- **Limits:** 2 members per room, 50 chat messages kept in memory per room, rooms deleted when empty,
  10 000 rooms max (protects the free-tier memory), `maxHttpBufferSize: 16 KB`.
- **Room switching:** a socket that joins a new room leaves its old one first.
- **Same-name rejoin:** if a phone drops and reconnects before the server notices the old socket
  died, the old socket for that room is evicted, so a person can't lock themselves out with their own ghost.
  (We match a random `clientId` the browser keeps in `sessionStorage`, not the name.)
- **Security:** `ALLOWED_ORIGINS` env var (comma-separated; localhost allowed in development),
  validation on every event, token-bucket rate limits, no HTML ever produced, chat text treated as plain text.
- **Health:** `GET /health` → `{ status, rooms, uptime }` (also used by the frontend to wake the server).
- **Logs:** one line per join, leave, or error. No chat contents logged (privacy).
- **Shutdown:** on `SIGTERM` (Render redeploys), close sockets politely so clients reconnect at once.

---

## 6. Frontend plan

### 6.1 Screens and flow

```
  /                      /room/:id
┌──────────┐  create   ┌──────────────┐  file ready  ┌──────────────┐
│  Home    │ ────────▶ │  Setup       │ ───────────▶ │  Theater     │
│ name     │  join     │ room status  │              │ video + chat │
│ Create / │ ────────▶ │ share link   │              │ + activity   │
│ Join     │           │ pick video   │              │ + subtitles  │
└──────────┘           │ (subtitles)  │              └──────────────┘
                       └──────────────┘
   "Waking up server…" only shows as a small banner if the server isn't ready yet;
   it never blocks typing a name or picking a file.
```

- **Waking the server early:** the page calls `/health` the moment it opens, so the ~50s Render
  wake-up runs while the user types a name and picks a file. Most of the wait disappears.
- **Name** is remembered in `localStorage`. Opening a shared link asks for a name once, then goes
  straight to setup.
- **Join room** accepts either a full link or just the code.

### 6.2 Works on every device

| Device | Theater layout |
|---|---|
| Phone, portrait | Video on top (16:9), then tabs **Chat / Activity**, slim bar at bottom (room, partner status, share) |
| Phone, landscape | Video fills the screen; a button opens chat as a slide-over panel |
| Tablet / desktop | Video left, side panel right with tabs **Chat / Activity** |

Rules applied everywhere:
- `100dvh` + `env(safe-area-inset-*)`, so nothing hides under notches or browser bars.
- Touch targets at least 44×44px. Inputs use 16px text (stops iPhone auto-zoom).
- The chat input stays visible when the phone keyboard opens (`visualViewport` handling).
- **Share link** uses the phone's native share sheet (`navigator.share`) when available, otherwise copies to the clipboard (with a fallback for older browsers).
- Native video controls (each OS's own controls, which already work well with touch and fullscreen).
- Accessible: real `<button>`s and `<label>`s, visible focus outlines, works with the keyboard only,
  chat and log announced to screen readers (`aria-live`), colour contrast ≥ 4.5:1,
  respects "reduce motion".
- Keyboard shortcuts on desktop: Space = play/pause, ←/→ = 5s seek, C = focus chat.

### 6.3 Subtitles
- Each person picks their own `.srt` or `.vtt` file (subtitles are local too, never uploaded).
- `.srt` is converted to WebVTT in the browser, then attached as a `<track>`.
- Controls: on/off, offset adjustment (−/+ 0.5s steps) for subtitle files that are slightly off.
- Optional: drag-and-drop a subtitle file onto the video.

### 6.4 Chat
- Message list + input; Enter to send (Shift+Enter for a new line on desktop).
- Shows partner name and time; system messages (joined/left) inline but greyed.
- Unread badge on the Chat tab when you're viewing Activity.
- Rejoiners receive the last 50 messages kept in server memory; they disappear when the room empties.

### 6.5 File checks
- SHA-256 of the first 20 MB (same as spec), with progress shown. Mismatch → warning banner that
  names both files ("You: movie.mp4 · Partner: movie_720p.mp4"), never blocks playback.
- Duration also compared; a big difference is a strong hint the files differ.
- If the browser can't play the file (e.g. some `.mkv`/HEVC files on certain devices), say so
  clearly and suggest MP4 (H.264).

---

## 7. Testing plan

| Layer | Tool | What it proves |
|---|---|---|
| Backend unit | `node:test` | Room logic: limits, cleanup, state math, validation |
| Protocol integration | `node:test` + `socket.io-client` | Real server + 3 clients: join/full/leave, a 3rd person can't control the video, chat, rate limits, hash compare, late-join state |
| End-to-end | Playwright, two browser contexts | Two "people" in one room with a small test video: play/pause/seek mirror, late join catches up, drift snap-back, chat, subtitles load |
| Devices | Playwright device projects | Same tests on desktop Chrome, Firefox, **Pixel 7**, **iPhone 14 (WebKit)**, **iPad** + screenshots of every screen |
| Accessibility | Chrome DevTools/Lighthouse audit | No contrast, label, or tap-target failures |
| Manual | Your real phone + laptop | Final check before launch (checklist in README) |

Run all of it with `npm test` in each folder; `npm run test:e2e` in the frontend.

---

## 8. Local development

```bash
cd syncvid-backend  && npm install && npm run dev   # http://localhost:3001
cd syncvid-frontend && npm install && npm start     # http://localhost:5173
```
`public/js/config.js` uses `localhost:3001` (or `<your-PC-IP>:3001` on a home network)
automatically, so there's no URL to edit while developing. Phone testing over plain http on
Wi-Fi works too: hashing falls back to a built-in SHA-256 and copying falls back to the old
clipboard API. See README.md.

---

## 9. Deployment

1. **GitHub:** one repo with both folders.
2. **Render (backend):** `render.yaml` with `rootDir: syncvid-backend`, free plan, health check `/health`,
   env `ALLOWED_ORIGINS=https://<your-site>.netlify.app`. Auto-deploys on push.
3. **Netlify (frontend):** base directory `syncvid-frontend`, no build command, publish `.`.
   `netlify.toml`: `/room/*` → `index.html`, security headers (CSP allowing only our backend),
   long cache for `vendor/`, no cache for `index.html`.
4. **Wire together:** put the Render URL in `js/config.js` (production branch), put the Netlify URL in
   Render's `ALLOWED_ORIGINS`, redeploy both.
5. **Smoke test:** laptop + phone, same video, run through the checklist.

(Optional, decide later: a custom domain on Netlify, and a free uptime pinger to reduce cold starts.
Render's free hours cover one service running 24/7.)

---

## 10. Build order (milestones): all done

Each milestone ends with tests passing and something you can try yourself.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Foundation:** git repo, folders, `.gitignore`, `PROTOCOL.md`, READMEs, package.json files, vendored socket.io client | Both folders install and start |
| M1 | **Backend core:** rooms, join/leave/full, validation, rate limits, health, clock sync, unit + protocol tests | `npm test` green; bug #1 has a test proving it's fixed |
| M2 | **Frontend shell:** Home / Setup / Theater screens, responsive layouts, routing, connect + wake-up banner, share link | Two tabs can join the same room on desktop and phone sizes |
| M3 | **Sync engine:** control/state, echo guard, late join, drift, autoplay fallback, reconnect, file hashing | E2E: play/pause/seek mirror on all device projects |
| M4 | **Nicknames + chat** | E2E chat test passes; unread badge, keyboard handling on phones |
| M5 | **Subtitles** | .srt and .vtt load, offset works, on all devices |
| M6 | **Polish:** accessibility audit, error states (bad file, room full, server down), keyboard shortcuts, light/dark | Lighthouse accessibility ≥ 95; screenshots reviewed |
| M7 | **Deploy:** Render + Netlify, CORS locked, real-device smoke test | Works laptop ↔ phone over the internet |

---

## 11. Known limits (accepted)

- First visit after 15 min idle: up to ~50s for the server to wake (mostly hidden by early wake-up).
- Server restart (deploys, Render maintenance) drops rooms and chat; clients reconnect and recreate
  the room automatically with the current state from whoever is still there.
- Video formats depend on each device's browser (MP4/H.264 works everywhere).
- Exactly 2 people per room (by design).
- Refreshing the page means picking the video file again (browsers don't allow keeping file access).
