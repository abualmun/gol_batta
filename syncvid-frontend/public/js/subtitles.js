/**
 * Local subtitle files: load .srt/.vtt, attach to the <video> as a <track>, adjust timing.
 * Subtitles never leave the device, and each person picks their own.
 */

import { buildVtt, decodeSubtitleBytes, parseSubtitles } from "./subtitles-parse.js";

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
export const OFFSET_STEP_S = 0.5;

export function createSubtitles(video, { onChange }) {
  let cues = null;
  let fileName = null;
  let offset = 0;
  let visible = true;
  let trackEl = null;
  let blobUrl = null;

  function detach() {
    trackEl?.remove();
    trackEl = null;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  function attach() {
    detach();
    if (!cues) return;
    blobUrl = URL.createObjectURL(new Blob([buildVtt(cues, offset)], { type: "text/vtt" }));
    trackEl = document.createElement("track");
    trackEl.kind = "subtitles";
    trackEl.label = fileName;
    trackEl.srclang = "und";
    trackEl.src = blobUrl;
    trackEl.default = true;
    video.append(trackEl);
    applyVisibility();
    // Some browsers reset the mode once the track has loaded.
    trackEl.addEventListener("load", applyVisibility, { once: true });
  }

  function applyVisibility() {
    if (trackEl?.track) trackEl.track.mode = visible ? "showing" : "hidden";
  }

  function emit() {
    onChange({ loaded: Boolean(cues), fileName, offset, visible, count: cues?.length ?? 0 });
  }

  return {
    /** @returns {Promise<{ ok: true, count: number } | { ok: false, error: string }>} */
    async load(file) {
      if (!/\.(srt|vtt)$/i.test(file.name)) {
        return { ok: false, error: "Choose a .srt or .vtt subtitle file." };
      }
      if (file.size > MAX_SUBTITLE_BYTES) {
        return { ok: false, error: "That subtitle file is too large (over 5 MB)." };
      }
      let parsed;
      try {
        parsed = parseSubtitles(decodeSubtitleBytes(await file.arrayBuffer()));
      } catch {
        return { ok: false, error: "That subtitle file couldn't be read." };
      }
      if (parsed.length === 0) {
        return { ok: false, error: "No subtitles were found in that file." };
      }
      cues = parsed;
      fileName = file.name;
      offset = 0;
      visible = true;
      attach();
      emit();
      return { ok: true, count: parsed.length };
    },

    /** Shift subtitles: negative = show earlier, positive = show later. */
    shift(deltaSeconds) {
      if (!cues) return;
      offset = Math.round((offset + deltaSeconds) * 10) / 10;
      attach();
      emit();
    },

    resetOffset() {
      if (!cues || offset === 0) return;
      offset = 0;
      attach();
      emit();
    },

    setVisible(value) {
      visible = value;
      applyVisibility();
      emit();
    },

    remove() {
      cues = null;
      fileName = null;
      offset = 0;
      detach();
      emit();
    },

    /** Re-attach after the video source changed (a new <video> src drops nothing, but be safe). */
    refresh() {
      if (cues) attach();
    },
  };
}
