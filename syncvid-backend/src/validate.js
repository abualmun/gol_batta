/**
 * Payload validators. Each returns the cleaned value, or `null` when the input is invalid.
 * Nothing from a client is trusted: every socket handler goes through these.
 */

const CONTROL_CHARS = /[\p{Cc}]/gu; // C0/C1 control characters (includes \n, \t, \r)
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\p{Cc}--[\n]]/gv; // `v` flag: set subtraction
// Bidi overrides/isolates and marks: can be used to visually spoof text.
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const MAX_POSITION_SECONDS = 1_000_000; // ~11.5 days — far beyond any real video

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(str) {
  let n = 0;
  for (const _ of str) n++;
  return n;
}

function truncateCodePoints(str, max) {
  return Array.from(str).slice(0, max).join("");
}

/** Room ids: 4–32 chars of a-z, 0-9 and "-", not starting/ending with "-". Case-insensitive. */
export function roomId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(id) ? id : null;
}

/** Display names: 1–24 characters, single-spaced, no control or bidi characters. */
export function name(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  const len = codePointLength(cleaned);
  return len >= 1 && len <= 24 ? cleaned : null;
}

/** Chat text: 1–500 characters; newlines kept (max 2 in a row), other control chars removed. */
export function chatText(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_EXCEPT_NEWLINE, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const len = codePointLength(cleaned);
  return len >= 1 && len <= 500 ? cleaned : null;
}

/** Per-browser-tab random id, used only to recognise a reconnecting tab. Never broadcast. */
export function clientId(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : null;
}

/** Playback position in seconds. */
export function position(raw) {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= MAX_POSITION_SECONDS
    ? raw
    : null;
}

/** Video duration in seconds; `null` when unknown (allowed). Returns `undefined` when invalid. */
export function duration(raw) {
  if (raw === null || raw === undefined) return null;
  return position(raw) ?? undefined;
}

/** SHA-256 hex digest. */
export function hash(raw) {
  return typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

/** File name shown to the partner. Always returns a string (falls back to a placeholder). */
export function fileName(raw) {
  if (typeof raw !== "string") return "Unknown file";
  const cleaned = truncateCodePoints(
    raw.replace(CONTROL_CHARS, " ").replace(BIDI_CONTROLS, "").trim(),
    200,
  );
  return cleaned || "Unknown file";
}

/** Video control actions. */
export function action(raw) {
  return raw === "play" || raw === "pause" || raw === "seek" ? raw : null;
}

/** A server-clock timestamp (ms) sent by a client. Must be within ±30 s of `now`. */
export function serverTimestamp(raw, now) {
  return typeof raw === "number" && Number.isFinite(raw) && Math.abs(raw - now) <= 30_000
    ? raw
    : null;
}
