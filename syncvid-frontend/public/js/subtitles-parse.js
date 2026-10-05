/**
 * Subtitle parsing (SRT and WebVTT) and WebVTT generation. Pure functions, no DOM.
 */

const TIME_LINE =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})/;

/** "01:02:03,450" / "02:03.4" → seconds. */
export function parseTimestamp(raw) {
  const [clock, fraction = "0"] = raw.trim().replace(",", ".").split(".");
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s + Number(`0.${fraction}`);
}

/** seconds → "hh:mm:ss.mmm" (WebVTT). */
export function formatVttTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * Parse SRT or WebVTT text into cues. Unknown blocks (NOTE, STYLE, REGION, garbage) are skipped.
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseSubtitles(text) {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => TIME_LINE.test(line));
    // The time line is the first line (VTT without id) or the second (SRT number / VTT id).
    if (timeIndex === -1 || timeIndex > 1) continue;
    const [, startRaw, endRaw] = lines[timeIndex].match(TIME_LINE);
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    const body = lines
      .slice(timeIndex + 1)
      .join("\n")
      .trim();
    if (!body || !(end > start)) continue;
    cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Build a WebVTT document from cues, shifted by `offsetSeconds` (positive = later). */
export function buildVtt(cues, offsetSeconds = 0) {
  const out = ["WEBVTT", ""];
  for (const cue of cues) {
    const start = cue.start + offsetSeconds;
    const end = cue.end + offsetSeconds;
    if (end <= 0) continue;
    out.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    // "-->" inside cue text would be read as a timing line.
    out.push(cue.text.replace(/-->/g, "->"), "");
  }
  return out.join("\n");
}

/**
 * Decode subtitle file bytes. Many .srt files are not UTF-8 (older Windows encodings),
 * so: honour a BOM, try strict UTF-8, then guess between Arabic (windows-1256) and
 * Western European (windows-1252) by which one yields Arabic letters.
 */
export function decodeSubtitleBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8 — fall through to single-byte encodings.
  }
  const arabic = new TextDecoder("windows-1256").decode(bytes);
  const arabicLetters = (arabic.match(/[؀-ۿ]/g) || []).length;
  const highBytes = bytes.reduce((n, b) => n + (b >= 0x80 ? 1 : 0), 0);
  if (highBytes > 0 && arabicLetters / highBytes > 0.6) return arabic;
  return new TextDecoder("windows-1252").decode(bytes);
}
