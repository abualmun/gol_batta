# SyncVid backend

Socket.io room server. Rooms, playback state and chat live in memory. There is no database.
The wire protocol is documented in [`../PROTOCOL.md`](../PROTOCOL.md).

```bash
npm install
npm run dev     # restarts on file changes, http://localhost:3001
npm start       # production
npm test        # unit tests + protocol tests against a real server
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Port to listen on (Render sets this). |
| `ALLOWED_ORIGINS` | *(empty = allow all)* | Comma-separated frontend origins. `*` matches one name part, e.g. `https://*--syncvid.netlify.app` for Netlify previews. Applies to HTTP and WebSockets. |
| `NODE_ENV` | | `production` on Render. |

## Files

| File | Role |
|---|---|
| `server.js` | Entry point: starts the server, shuts down cleanly on SIGTERM. |
| `src/app.js` | Builds Express + Socket.io (also used by the tests). |
| `src/handlers.js` | One function per socket event. |
| `src/rooms.js` | Room logic (members, state, files, chat) as plain functions, no sockets. |
| `src/validate.js` | Validation for every incoming field. |
| `src/rateLimit.js` | Per-connection token buckets. |
| `src/origins.js` | `ALLOWED_ORIGINS` matching. |

## Limits

2 people per room, 10 000 rooms, the last 50 chat messages per room, 16 KB per message.
Rate limits are listed in `PROTOCOL.md`.
# gol_batta
