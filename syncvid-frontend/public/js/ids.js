/**
 * Room ids and per-tab client ids.
 */

// No 0/o, 1/l/i: easy to read aloud and type from a phone.
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Unbiased random string from `alphabet` using crypto.getRandomValues. */
function randomString(length, alphabet) {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** e.g. "k7mqp-x3ndr" */
export function generateRoomId() {
  const raw = randomString(10, ROOM_ALPHABET);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Same rule as the server: 4–32 of a-z 0-9 "-", not starting/ending with "-". */
export function normalizeRoomId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(id) ? id : null;
}

/** The room id in a path like "/room/abc-123", or null. */
export function roomIdFromPath(pathname) {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  return match ? normalizeRoomId(decodeURIComponent(match[1])) : null;
}

/** Accepts a full room link (any host) or a bare code. Returns the room id or null. */
export function parseRoomInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const linkMatch = /\/room\/([A-Za-z0-9-]+)/.exec(text);
  return normalizeRoomId(linkMatch ? linkMatch[1] : text);
}

/** Random id for this browser tab, used by the server to recognise a reconnect. */
export function generateClientId() {
  return randomString(22, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
}
