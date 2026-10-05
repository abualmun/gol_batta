# SyncVid wire protocol (v2)

The contract between `syncvid-backend` and `syncvid-frontend`. Both sides must follow it.
**If you change an event here, change both folders and their tests in the same commit.**

- Transport: Socket.io v4 (server `socket.io@4.8`, client `socket.io-client@4.8`, vendored in
  `syncvid-frontend/public/vendor/`).
- Every payload is a JSON object. The server validates every field and **silently drops**
  invalid messages, except where a reply or `room:error` is listed below.
- Times named `at` / `updatedAt` / `serverTime` are **server clock, milliseconds since epoch**.
  Clients convert with the offset measured by `time:ping`.
- Positions are **seconds** of video (number, `0 ≤ x ≤ 1 000 000`).
- Messages larger than 16 KB close the connection.
- Tests that pin this protocol down: `syncvid-backend/test/protocol.test.js`.

---

## Client → server

| Event | Payload | Reply / effect | Rate limit (burst, then per second) |
|---|---|---|---|
| `time:ping` | `{}` | ack `{ serverTime }` | 10, then 2/s |
| `room:join` | `{ roomId, name, clientId? }` | `room:joined`, `room:full` or `room:error` | 5, then 0.5/s |
| `room:leave` | `{}` | ack `{ ok: true }`; partner gets `room:peer_left` | 5, then 0.5/s |
| `video:hash` | `{ hash, fileName, duration }` | when both members have sent one: `video:hash_result` to each | 5, then 0.2/s |
| `video:control` | `{ action, position }` | `video:state` to **everyone in the room, sender included** | 10, then 4/s |
| `video:report` | `{ position, playing, at, seq }` | `video:peer_report` to the partner only | 3, then 1/s |
| `chat:send` | `{ text }` | ack `{ ok: true, id }` or `{ ok: false, error }`; `chat:message` to everyone | 5, then 1/s |

Field rules:

| Field | Rule |
|---|---|
| `roomId` | 4–32 chars of `a-z 0-9 -`, not starting or ending with `-`. Case-insensitive (server lowercases). Generated rooms look like `k7mqp-x3ndr`. |
| `name` | 1–24 characters after trimming and collapsing spaces. Control and bidi-override characters are removed. |
| `clientId` | Optional. `[A-Za-z0-9_-]{16,64}`, random per browser tab. Lets a reconnecting tab replace its own stale connection instead of hitting "room full". Never sent to other clients. |
| `hash` | SHA-256 hex (64 lowercase chars) of the **first 20 MB** of the file. |
| `fileName` | Shown to the partner. Truncated to 200 characters. |
| `duration` | Seconds, or `null` if unknown. |
| `action` | `"play"`, `"pause"` or `"seek"`. `seek` keeps the current play/pause state. |
| `playing` | Boolean. |
| `at` (report) | The client's estimate of server time when the position was read. If it's more than 30 s off, the server replaces it with its own time. |
| `seq` (report) | The `seq` of the last `video:state` this client applied. `null` if missing. |
| `text` | 1–500 characters after trimming; newlines allowed (at most 2 in a row). |

Only room members can send `video:*` and `chat:*`. Messages from a socket that isn't in a room
(for example one that got `room:full`) are ignored.

## Server → client

| Event | Payload |
|---|---|
| `room:joined` | `{ roomId, you: Member, peer: Member \| null, state: State \| null, chat: Message[] }` |
| `room:full` | `{ message }` |
| `room:error` | `{ code, message }`. `code` is one of: `invalid_room`, `invalid_name`, `server_busy` (room limit reached), `replaced` (this tab opened the room again in a newer connection; the old one is then disconnected), `rate_limited` |
| `room:peer_joined` | `{ peer: Member }` (also sent when a partner reconnects, with a new `id`) |
| `room:peer_left` | `{ peerId }` |
| `video:hash_result` | `{ match, yourFile: FileInfo, peerFile: FileInfo }` |
| `video:state` | `State` |
| `video:peer_report` | `{ position, playing, at, seq }` |
| `chat:message` | `Message` |

Types:

```
Member   = { id: string, name: string }          // id is random per connection
State    = { playing: boolean, position: number, updatedAt: number,
             seq: number, action: "play"|"pause"|"seek", by: Member }
FileInfo = { fileName: string, duration: number | null }
Message  = { id: string, from: Member, text: string, at: number }
```

## Rules both sides rely on

1. **The server's room state is the single source of truth.** A client never applies its own
   play/pause/seek to the partner directly. It sends `video:control` and waits for
   `video:state`. If two people act at the same moment, the server's order decides, and both
   screens end up the same.
2. **Where the video should be now:** `position + (serverNow − updatedAt) / 1000` while
   `playing`, otherwise `position`.
3. **`seq`** increases by 1 for every state in a room. Clients ignore states with a `seq` they
   have already seen. `seq` restarts at 1 if the server restarts. A client resets its counter
   from `room:joined`.
4. **Drift correction is client-side and backwards-only:** a client that is more than 1.5 s
   *ahead* of its partner's latest report (same `seq`, both playing) seeks back. A client
   that is behind does nothing.
5. **Late joiners** get the current `state` in `room:joined`. A client that rejoins and gets
   `state: null` (the server restarted) re-sends its own player state with `video:control`.
6. **Rooms** hold at most 2 members. Empty rooms are deleted immediately, together with their
   chat history (the last 50 messages are kept while the room exists).
7. Chat text is plain text. Clients must render it as text, never as HTML.

## HTTP

| Route | Response |
|---|---|
| `GET /health` | `{ status: "ok", rooms, uptime }` (`Cache-Control: no-store`). Used by Render's health check, and by the frontend to wake the server and keep it awake during a session. |
| `GET /` | `{ service, version }` |

Allowed origins come from the `ALLOWED_ORIGINS` environment variable, which applies to both
HTTP CORS and the WebSocket handshake.
