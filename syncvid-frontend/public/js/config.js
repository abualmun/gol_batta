/**
 * Frontend configuration.
 *
 * Before deploying: set PRODUCTION_BACKEND_URL to your Render service URL.
 * On localhost / your home network the backend is assumed to run on port 3001 of the same machine.
 */

const PRODUCTION_BACKEND_URL = "https://syncvid-server.onrender.com";

const DEV_BACKEND_PORT = 3001;

function isLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".local") ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  );
}

/**
 * `?backend=https://…` overrides the backend for this tab (handy for tunnels and testing).
 * It's kept in sessionStorage because the query string is lost when navigating to a room.
 */
function pickBackendUrl() {
  try {
    const override = new URLSearchParams(location.search).get("backend");
    if (override && /^https?:\/\/[^\s/]+$/.test(override)) {
      sessionStorage.setItem("syncvid:backend", override);
    }
    const stored = sessionStorage.getItem("syncvid:backend");
    if (stored) return stored;
  } catch {
    // Storage blocked — fall through to the defaults.
  }
  if (isLocalHost(location.hostname)) {
    return `${location.protocol}//${location.hostname}:${DEV_BACKEND_PORT}`;
  }
  return PRODUCTION_BACKEND_URL;
}

export const BACKEND_URL = pickBackendUrl();

/** Playback drift (seconds) before the player that is ahead jumps back. */
export const DRIFT_THRESHOLD_S = 1.5;
/** How often each player reports its position to the partner. */
export const REPORT_INTERVAL_MS = 3000;
/** Ignore small differences when applying a partner's play/pause/seek. */
export const SEEK_TOLERANCE_S = 0.5;
/** Bytes read from the start of the file to fingerprint it. */
export const HASH_SAMPLE_BYTES = 20 * 1024 * 1024;
/** Durations further apart than this are reported as different files. */
export const DURATION_TOLERANCE_S = 2;

export const NAME_MAX_LENGTH = 24;
export const CHAT_MAX_LENGTH = 500;
