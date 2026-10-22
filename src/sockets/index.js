"use strict";

const {
    isValidClientType,
    isValidUid,
    isValidDeviceId
} = require("../utils/validators");
const { registerWebHandlers } = require("./handlers/web.handlers");
const { registerAndroidHandlers } = require("./handlers/android.handlers");
const { registerPresenceHandlers } = require("./handlers/presence.handlers");

function initSockets(io, deps) {
    const {
        activeSockets,
        eventService,
        fcmService,
        presenceService,
        deliveryService,
        rateLimiter,
        config,
        logger
    } = deps;

    function rejectConnection(socket, code, message) {
        logger.warn("Rejected Socket.IO connection", {
            socketId: socket.id,
            code
        });

        socket.emit("connection:error", { code, message });
        socket.disconnect(true);
    }

    io.on("connection", (socket) => {
        // Prefer handshake.auth. Query fallback keeps compatibility with
        // Socket.IO client libraries that cannot send an auth map.
        const auth = socket.handshake.auth || {};
        const query = socket.handshake.query || {};
        const clientType = auth.clientType ?? query.clientType;
        const uid = auth.uid ?? query.uid;
        const rawDeviceId = auth.deviceId ?? query.deviceId;
        const deviceId = clientType === "android" ? rawDeviceId : null;

        if (!isValidClientType(clientType)) {
            rejectConnection(
                socket,
                "INVALID_CLIENT_TYPE",
                'clientType must be "web" or "android"'
            );
            return;
        }

        if (!isValidUid(uid)) {
            rejectConnection(
                socket,
                "INVALID_UID",
                "A valid client-supplied uid is required"
            );
            return;
        }

        if (clientType === "android" && !isValidDeviceId(deviceId)) {
            rejectConnection(
                socket,
                "INVALID_DEVICE_ID",
                "Android clients must supply a stable deviceId"
            );
            return;
        }

        const connectedAt = Date.now();

        const record = {
            socketId: socket.id,
            socket,
            clientType,
            uid,
            deviceId,
            connectedAt,
            lastSeen: connectedAt,
            lastHeartbeatAt: connectedAt
        };

        activeSockets.add(record);

        socket.data.clientType = clientType;
        socket.data.uid = uid;
        socket.data.deviceId = deviceId;
        socket.data.connectedAt = connectedAt;

        const handlers = {
            eventService,
            fcmService,
            presenceService,
            rateLimiter,
            logger,
            config
        };

        if (clientType === "web") {
            registerWebHandlers(socket, handlers);
        } else {
            registerAndroidHandlers(socket, handlers);
        }

        registerPresenceHandlers(socket, handlers);

        socket.emit("connection:ready", {
            socketId: socket.id,
            clientType,
            uid,
            deviceId,
            serverTime: Date.now(),
            ackTimeoutMs: config.ackTimeoutMs,
            payloadMaxBytes: config.eventPayloadMaxBytes,
            allowedEventTypes: config.allowedEventTypes
        });

        logger.info("Socket.IO client connected", {
            socketId: socket.id,
            clientType,
            uid,
            deviceId
        });

        if (clientType === "android") {
            presenceService.handleAndroidConnect(socket).catch((error) => {
                logger.error("Android presence connect handling failed", {
                    socketId: socket.id,
                    code: error.code,
                    message: error.message
                });
            });
        }

        socket.on("disconnect", (reason) => {
            activeSockets.remove(socket.id);

            deliveryService.handleSocketDisconnect(socket.id);
            presenceService.removeSocket(socket.id);

            if (clientType === "android") {
                presenceService
                    .handleAndroidDisconnect(record)
                    .catch((error) => {
                        logger.error(
                            "Android presence disconnect handling failed",
                            {
                                socketId: socket.id,
                                code: error.code,
                                message: error.message
                            }
                        );
                    });
            }

            logger.info("Socket.IO client disconnected", {
                socketId: socket.id,
                clientType,
                uid,
                deviceId,
                reason
            });
        });

        socket.on("error", (error) => {
            logger.warn("Socket.IO socket error", {
                socketId: socket.id,
                message: error && error.message
            });
        });
    });
}

module.exports = { initSockets };
