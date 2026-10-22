"use strict";

const http = require("node:http");
const { Server } = require("socket.io");

const { createApp } = require("../../src/app");
const { ActiveSocketsStore } = require("../../src/stores/activeSockets.store");
const { PendingEventsStore } = require("../../src/stores/pendingEvents.store");
const { createFcmService } = require("../../src/services/fcm.service");
const {
    createPresenceService
} = require("../../src/services/presence.service");
const {
    createDeliveryService
} = require("../../src/services/delivery.service");
const { createEventService } = require("../../src/services/event.service");
const { createSocketRateLimiter } = require("../../src/utils/rateLimiter");
const { initSockets } = require("../../src/sockets");
const { testConfig } = require("./fixtures");
const {
    silentLogger,
    createFakeDb,
    createFakeMessaging
} = require("./fakes");

const testServerConfig = Object.freeze({
    ...testConfig,
    corsOrigins: "*",
    socketPingIntervalMs: 25000,
    socketPingTimeoutMs: 60000,
    socketMaxHttpBufferBytes: 1048576,
    eventHardTimeoutMs: 5000,
    presenceStaleMs: 120000,
    presenceHeartbeatWriteMs: 1000
});

async function startTestServer(options = {}) {
    const config = { ...testServerConfig, ...(options.config || {}) };
    const db = options.db || createFakeDb();
    const messaging = options.messaging || createFakeMessaging();

    const activeSockets = new ActiveSocketsStore();
    const pendingStore = new PendingEventsStore({
        maxEvents: config.maxInFlightEvents
    });

    const fcmService = createFcmService({
        db,
        messaging,
        serverTimestamp: 1700000000000,
        logger: silentLogger
    });

    let io;

    function sendToSocket(socketId, eventName, payload) {
        if (!activeSockets.has(socketId)) return false;
        io.to(socketId).emit(eventName, payload);
        return true;
    }

    const presenceService = createPresenceService({
        activeSockets,
        db,
        config,
        logger: silentLogger,
        sendToSocket,
        serverTimestamp: 1700000000000
    });

    const deliveryService = createDeliveryService({
        pendingStore,
        activeSockets,
        fcm: fcmService,
        notify: (originSocketId, payload) =>
            sendToSocket(originSocketId, "event:status", payload),
        config,
        logger: silentLogger
    });

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

    const eventService = createEventService({
        pendingStore,
        activeSockets,
        delivery: deliveryService,
        fcm: fcmService,
        rateLimiter,
        config,
        logger: silentLogger
    });

    const app = createApp({
        config,
        logger: silentLogger,
        getStats: () => ({
            socketClients: io ? io.engine.clientsCount : 0,
            activeSockets: activeSockets.size,
            inFlightEvents: pendingStore.size
        })
    });

    const httpServer = http.createServer(app);

    io = new Server(httpServer, {
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
    });

    initSockets(io, {
        activeSockets,
        eventService,
        fcmService,
        presenceService,
        deliveryService,
        rateLimiter,
        config,
        logger: silentLogger
    });

    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => {
            httpServer.removeListener("error", reject);
            resolve();
        });
    });

    const port = httpServer.address().port;

    return {
        url: `http://127.0.0.1:${port}`,
        config,
        db,
        messaging,
        activeSockets,
        pendingStore,
        fcmService,
        presenceService,
        deliveryService,
        eventService,
        io,
        close: () =>
            new Promise((resolve) => {
                io.close(() => {
                    deliveryService.shutdown();
                    activeSockets.clear();
                    resolve();
                });
            })
    };
}

module.exports = { startTestServer, testServerConfig };
