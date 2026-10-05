/**
 * Builds the HTTP + Socket.io server without starting it (tests start it on a random port).
 */

import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { registerHandlers } from "./handlers.js";
import { createOriginChecker } from "./origins.js";
import { createRoomStore } from "./rooms.js";

export const VERSION = "2.0.0";

export function createSyncVidServer(config, { log = console.log } = {}) {
  const isAllowedOrigin = createOriginChecker(config.allowedOrigins);
  const store = createRoomStore({
    maxRooms: config.maxRooms,
    maxMembers: config.maxMembersPerRoom,
    chatHistorySize: config.chatHistorySize,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ["GET"],
    }),
  );

  // Used by Render's health monitor and by the frontend to wake the server up early.
  app.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok", rooms: store.size, uptime: Math.round(process.uptime()) });
  });

  app.get("/", (_req, res) => {
    res.json({ service: "SyncVid server", version: VERSION });
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: config.maxPayloadBytes,
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ["GET", "POST"],
    },
    // Applies to every transport, including WebSocket upgrades.
    allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin)),
  });

  io.on("connection", (socket) => registerHandlers(io, socket, store, log));

  return { httpServer, io, store };
}
