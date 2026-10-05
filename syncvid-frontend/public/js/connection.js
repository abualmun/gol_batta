/**
 * Socket connection + clock sync.
 *
 * Clock sync: a few `time:ping`s; the reply with the shortest round trip gives the best
 * estimate of (server clock − our clock). All playback timing uses `serverNow()`, so two
 * phones whose clocks disagree still agree on "where the video should be now".
 */

/* global io */

const CLOCK_SAMPLES = 5;
const CLOCK_RESYNC_MS = 60_000;

export function createConnection(url, { onStatus, onReady }) {
  const socket = io(url, {
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20_000,
  });

  let offsetMs = 0;
  let rttMs = null;
  let resyncTimer = null;

  async function syncClock(samples = CLOCK_SAMPLES) {
    let best = null;
    for (let i = 0; i < samples && socket.connected; i++) {
      const t0 = Date.now();
      try {
        const { serverTime } = await socket.timeout(5000).emitWithAck("time:ping", {});
        const t1 = Date.now();
        const sample = { rtt: t1 - t0, offset: serverTime - (t0 + t1) / 2 };
        if (!best || sample.rtt < best.rtt) best = sample;
      } catch {
        // Lost or late reply — use the other samples.
      }
    }
    if (best) {
      offsetMs = best.offset;
      rttMs = best.rtt;
    }
  }

  socket.on("connect", async () => {
    onStatus("connected");
    await syncClock();
    clearInterval(resyncTimer);
    resyncTimer = setInterval(() => syncClock(3), CLOCK_RESYNC_MS);
    if (socket.connected) onReady();
  });

  socket.on("disconnect", (reason) => {
    clearInterval(resyncTimer);
    // "io client disconnect" = we closed it on purpose; anything else reconnects automatically.
    onStatus(reason === "io client disconnect" ? "closed" : "reconnecting");
  });

  socket.on("connect_error", () => {
    if (!socket.active) onStatus("failed");
    else onStatus("reconnecting");
  });

  return {
    socket,
    /** Current time on the server's clock (ms). */
    serverNow: () => Date.now() + offsetMs,
    get rttMs() {
      return rttMs;
    },
    emit: (event, payload) => {
      if (socket.connected) socket.emit(event, payload);
    },
    emitWithAck: (event, payload, timeoutMs = 5000) =>
      socket.timeout(timeoutMs).emitWithAck(event, payload),
    on: (event, handler) => socket.on(event, handler),
  };
}
