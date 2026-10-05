/**
 * Runtime configuration, read once from environment variables.
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * ALLOWED_ORIGINS is a comma-separated list of origins that may connect, e.g.
 *   https://syncvid.netlify.app,https://*--syncvid.netlify.app
 * A "*" inside an entry matches one hostname label part (letters, digits, dashes),
 * which covers Netlify deploy previews. Empty / unset = allow every origin.
 */
function parseOrigins(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export const config = Object.freeze({
  port: Number(process.env.PORT) || 3001,
  isProduction,
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),

  maxMembersPerRoom: 2,
  maxRooms: 10_000,
  chatHistorySize: 50,
  maxPayloadBytes: 16 * 1024,
});
