"use strict";

require("dotenv").config({ quiet: true });

const http = require("node:http");
const { Server } = require("socket.io");

const { loadEnv } = require("./config/env");
const { initFirebase } = require("./config/firebase");
const { createLogger } = require("./utils/logger");
const { createSocketRateLimiter } = require("./utils/rateLimiter");
const { ActiveSocketsStore } = require("./stores/activeSockets.store");
const { PendingEventsStore } = require("./stores/pendingEvents.store");
const { createFcmService } = require("./services/fcm.service");
const { createPresenceService } = require("./services/presence.service");
const { createDeliveryService } = require("./services/delivery.service");
const { createEventService } = require("./services/event.service");
const { initSockets } = require("./sockets");
const { createApp } = require("./app");

function createIo(httpServer, config) {
    return new Server(httpServer, {
        cors: {
            origin: config.corsOrigins,
            methods: ["GET", "POST"]
        },
        transports: ["polling", "websocket"],
        allowEIO3: false,
        serveClient: false,
        maxHttpBufferSize: config.socketMaxHttpBufferBytes,
        pingInterval: config.socketPingIntervalMs,
        pingTimeout: config.socketPingTimeoutMs
        // connectionStateRecovery is intentionally disabled: disconnected
        // sockets never receive replayed private event status notifications.
    });
}

async function main() {
    const config = loadEnv();
    const logger = createLogger({ level: config.logLevel });

    logger.info("Starting hybrid WebSocket + FCM backend", {
        nodeEnv: config.nodeEnv,
        port: config.port,
        ackTimeoutMs: config.ackTimeoutMs,
        presenceStaleMs: config.presenceStaleMs
    });

    let firebase;

    try {
        firebase = initFirebase(config, logger);
    } catch (error) {
        logger.error("Firebase Admin SDK initialization failed", {
            message: error.message
        });
        process.exitCode = 1;
        return;
    }

    const { db, messaging, serverTimestamp } = firebase;

    const activeSockets = new ActiveSocketsStore();
    const pendingStore = new PendingEventsStore({
        maxEvents: config.maxInFlightEvents
    });

    let io;

    const rateLimiter = createSocketRateLimiter({
        windowMs: config.rateLimits.windowMs,
        limits: {
            eventSend: config.rateLimits.eventSend,
            eventStatus: config.rateLimits.eventStatus,
            fcmRegister: config.rateLimits.fcmRegister,
            presence: config.rateLimits.presence,
            heartbeat: config.rateLimits.heartbeat
        }
    });

    const fcmService = createFcmService({
        db,
        messaging,
        serverTimestamp,
        logger
    });

    function sendToSocket(socketId, eventName, payload) {
        if (!activeSockets.has(socketId)) return false;
        io.to(socketId).emit(eventName, payload);
        return true;
    }

    const presenceService = createPresenceService({
        activeSockets,
        db,
        config,
        logger,
        sendToSocket,
        serverTimestamp
    });

    const deliveryService = createDeliveryService({
        pendingStore,
        activeSockets,
        fcm: fcmService,
        notify: (originSocketId, payload) =>
            sendToSocket(originSocketId, "event:status", payload),
        config,
        logger
    });

    const eventService = createEventService({
        pendingStore,
        activeSockets,
        delivery: deliveryService,
        fcm: fcmService,
        rateLimiter,
        config,
        logger
    });

    const app = createApp({
        config,
        logger,
        getStats: () => ({
            socketClients: io ? io.engine.clientsCount : 0,
            activeSockets: activeSockets.size,
            inFlightEvents: pendingStore.size
        })
    });

    const httpServer = http.createServer(app);
    io = createIo(httpServer, config);

    initSockets(io, {
        activeSockets,
        eventService,
        fcmService,
        presenceService,
        deliveryService,
        rateLimiter,
        config,
        logger
    });

    if (config.reconcilePresenceOnStart) {
        await presenceService.reconcileOnStart();
    }

    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, () => {
            httpServer.removeListener("error", reject);
            resolve();
        });
    });

    logger.info("Server listening", {
        port: config.port,
        corsOrigins: config.corsOrigins
    });

    let shuttingDown = false;

    function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Graceful shutdown started", { signal });

        const forceExit = setTimeout(() => {
            logger.error("Forced shutdown after timeout");
            process.exit(1);
        }, 10000);

        if (typeof forceExit.unref === "function") {
            forceExit.unref();
        }

        io.close(() => {
            deliveryService.shutdown();
            activeSockets.clear();
            clearTimeout(forceExit);
            logger.info("Graceful shutdown complete");
            process.exit(0);
        });
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled promise rejection", {
            message: reason instanceof Error ? reason.message : String(reason)
        });
    });

    process.on("uncaughtException", (error) => {
        logger.error("Uncaught exception", {
            message: error.message,
            stack: error.stack
        });
        shutdown("uncaughtException");
    });
}

main().catch((error) => {
    console.error("Fatal startup error:", error.message);
    process.exitCode = 1;
});
