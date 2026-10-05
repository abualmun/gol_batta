# SyncVid

Watch the same video with a friend, in sync, from two places. Each of you opens your own copy
of the video file. SyncVid keeps play, pause and seeking in step and adds a small chat.
The video is never uploaded.

| Folder | What it is | Hosted on |
|---|---|---|
| [`syncvid-backend/`](syncvid-backend/) | Node.js + Socket.io room server, in memory, no database | Render (free) |
| [`syncvid-frontend/`](syncvid-frontend/) | Static site, plain JavaScript, no build step | Netlify (free) |
| [`PROTOCOL.md`](PROTOCOL.md) | The contract between the two (every event and field) | |
| [`PLAN.md`](PLAN.md) | Design decisions and why | |

## Run it on your computer

You need Node.js 20 or newer.

```bash
# Terminal 1: backend on http://localhost:3001
cd syncvid-backend
npm install
npm run dev

# Terminal 2: frontend on http://localhost:5173
cd syncvid-frontend
npm install
npm start
```

Open http://localhost:5173 in two browser windows (or a normal and a private window) to try
it alone. On `localhost` the frontend automatically uses the backend on port 3001.

### Try it on your phone at home

Phone and computer on the same Wi-Fi: find your computer's address (for example `192.168.1.20`)
and open `http://192.168.1.20:5173` on the phone. The frontend then uses
`http://192.168.1.20:3001` for the backend automatically.

## Tests

```bash
cd syncvid-backend  && npm test          # unit + protocol tests (real server, real clients)
cd syncvid-frontend && npm test          # unit tests (hashing, subtitles, ids, deploy config)
cd syncvid-frontend && npx playwright install   # once: downloads test browsers
cd syncvid-frontend && npm run test:e2e  # two people in two browsers, on 5 devices
```

The end-to-end tests run two people at once on desktop Chrome, desktop Firefox, an Android
phone (Pixel 7), an iPhone 14 and an iPad. They also run under the production
Content-Security-Policy. They start their own servers on ports 3101, 5174 and 5175.

## Deploy

### 1. Put the code on GitHub
Create a repository and push this folder (both subfolders together).

### 2. Backend on Render
1. In Render: **New → Blueprint**, choose your repository. Render reads `render.yaml`.
2. When asked for `ALLOWED_ORIGINS`, enter your future Netlify address, e.g.
   `https://syncvid.netlify.app,https://*--syncvid.netlify.app`
   (the second part allows Netlify preview links). You can change it later under
   *Environment*.
3. Wait for the deploy, then open `https://<your-service>.onrender.com/health`. You should
   see `{"status":"ok",…}`.

### 3. Point the frontend at your backend
If your Render address is **not** `https://syncvid-server.onrender.com`, change it in two places:
- `syncvid-frontend/public/js/config.js` → `PRODUCTION_BACKEND_URL`
- `netlify.toml` → the `connect-src` part of `Content-Security-Policy` (both `https://` and `wss://`)

`npm test` in `syncvid-frontend` fails if these two don't match.

### 4. Frontend on Netlify
In Netlify: **Add new site → Import an existing project**, choose the repository.
`netlify.toml` already sets everything (base `syncvid-frontend`, publish `public`, no build).

### 5. Check
Open your Netlify address on a laptop and on a phone, create a room on one and open the
link on the other, pick the same video on both, and press play.

## Good to know

- **First visit after a quiet period:** Render's free server sleeps after 15 minutes without
  visitors and takes up to a minute to wake. The page starts waking it as soon as it opens
  and shows a notice if it's still waking. During a session the page keeps it awake.
- **Server restarts** (deploys, maintenance) drop rooms and chat. Open pages reconnect by
  themselves and restore the room from the players.
- **Best format:** MP4 (H.264 video, AAC audio) plays everywhere. Some `.mkv` files and
  H.265/HEVC videos don't play in every browser; SyncVid tells you when that happens.
- **iPhone tip:** choosing a video from the *Photos* app may give a compressed copy, which then
  won't match your friend's file. Choose it from the *Files* app instead.
- **Refreshing the page** means picking the video file again (browsers don't let pages keep
  access to your files), so the page asks before you leave the theater.

## Troubleshooting

- **WebKit (iPhone/iPad) tests fail with "WebKit encountered an internal error"** when run from
  the VS Code *snap* terminal: the snap sets library paths that break WebKit.
  `playwright.config.js` clears them automatically. If you launch Playwright another way,
  `unset GIO_MODULE_DIR GTK_PATH LOCPATH` first.
- **"Connecting to the server…" never goes away:** check `/health` on your Render URL, and that
  `ALLOWED_ORIGINS` contains your exact Netlify address (with `https://`, without a trailing `/`).
# gol_batta
