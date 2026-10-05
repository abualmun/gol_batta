# SyncVid frontend

A static site in plain JavaScript (ES modules) with no build step. Everything that gets
published is in `public/`. The `package.json` here only holds tools for local serving and
testing.

```bash
npm install
npm start            # http://localhost:5173 (uses the backend on port 3001)
npm test             # unit tests
npm run test:e2e     # Playwright: two people, five devices (run `npx playwright install` once)
```

## Which backend is used

`public/js/config.js` chooses the backend:

- on `localhost` or a home-network address: the same machine, port 3001;
- anywhere else: `PRODUCTION_BACKEND_URL` (your Render URL);
- `?backend=https://…` in the address overrides it for that tab (for testing; the production
  CSP only allows the real backend).

## Files in `public/`

| File | Role |
|---|---|
| `index.html` | The three screens: home, room setup, theater. |
| `css/styles.css` | All styles, phone-first, light and dark. |
| `js/main.js` | App controller: routing, screens, file handling, room events. |
| `js/connection.js` | Socket.io connection and clock sync. |
| `js/sync.js` | The sync engine (state → player, echo guard, drift). |
| `js/panel.js` | Chat and Activity tabs. |
| `js/subtitles.js`, `js/subtitles-parse.js` | Subtitle loading (.srt/.vtt), timing offset. |
| `js/hash.js` | File fingerprint (SHA-256 of the first 20 MB, with a fallback for plain-http pages). |
| `js/ids.js` | Room ids and link parsing. |
| `js/ui.js` | Small DOM helpers: toasts, copy/share, safe storage. |
| `vendor/socket.io.min.js` | Socket.io client 4.8.4 (`npm run vendor` refreshes it). |
| `assets/fonts/` | Atkinson Hyperlegible Next and Bricolage Grotesque (SIL Open Font License). |

## Updating the Socket.io client

Keep the same major version as the backend's `socket.io`:

```bash
npm install socket.io-client@<version> --save-dev && npm run vendor
```
