/**
 * Origin allow-listing. Used for both HTTP CORS and WebSocket upgrades
 * (browsers don't apply CORS to WebSockets, so the server must check the Origin itself).
 */

function escapeRegExp(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string[]} patterns e.g. ["https://syncvid.netlify.app", "https://*--syncvid.netlify.app"]
 * @returns {(origin: string | undefined) => boolean}
 */
export function createOriginChecker(patterns) {
  if (patterns.length === 0) return () => true;
  const regexes = patterns.map(
    (p) => new RegExp(`^${p.split("*").map(escapeRegExp).join("[a-z0-9-]+")}$`, "i"),
  );
  return (origin) => {
    // Non-browser clients (curl, health checks) send no Origin header.
    if (!origin) return true;
    return regexes.some((re) => re.test(origin));
  };
}
