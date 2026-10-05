/**
 * Token-bucket rate limiting, one bucket per (socket, event).
 * `capacity` = burst size, `refillPerSec` = sustained rate.
 */

export const LIMITS = Object.freeze({
  "time:ping": { capacity: 10, refillPerSec: 2 },
  "room:join": { capacity: 5, refillPerSec: 0.5 },
  "room:leave": { capacity: 5, refillPerSec: 0.5 },
  "video:hash": { capacity: 5, refillPerSec: 0.2 },
  "video:control": { capacity: 10, refillPerSec: 4 },
  "video:report": { capacity: 3, refillPerSec: 1 },
  "chat:send": { capacity: 5, refillPerSec: 1 },
});

export function createRateLimiter(limits = LIMITS, now = Date.now) {
  const buckets = new Map(); // event -> { tokens, last }

  /** Returns true if the event is allowed (and consumes a token). */
  return function allow(event) {
    const limit = limits[event];
    if (!limit) return true;
    const t = now();
    let bucket = buckets.get(event);
    if (!bucket) {
      bucket = { tokens: limit.capacity, last: t };
      buckets.set(event, bucket);
    }
    const elapsedSec = (t - bucket.last) / 1000;
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsedSec * limit.refillPerSec);
    bucket.last = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}
