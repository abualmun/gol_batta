/**
 * SyncVid server entry point.
 */

import { createSyncVidServer, VERSION } from "./src/app.js";
import { config } from "./src/config.js";

const { httpServer, io } = createSyncVidServer(config);

if (config.allowedOrigins.length === 0) {
  console.warn(
    "[Warning] ALLOWED_ORIGINS is not set — any website can connect. " +
      "Set it to your frontend URL in production.",
  );
}

httpServer.listen(config.port, () => {
  console.log(`SyncVid server v${VERSION} listening on port ${config.port}`);
  console.log(`Health check: http://localhost:${config.port}/health`);
});

// Render sends SIGTERM before replacing the instance during deploys.
function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received, closing connections…`);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
