"use strict";

const { isValidFcmToken } = require("../../utils/validators");

function registerAndroidHandlers(socket, deps) {
    const { eventService, fcmService, rateLimiter, logger } = deps;

    socket.on("android:register-fcm", async (request, ack) => {
        const reply =
            typeof ack === "function" ? ack : () => undefined;

        if (!rateLimiter.allow(socket, "fcmRegister")) {
            reply({
                ok: false,
                error: { code: "RATE_LIMITED", message: "Too many token updates" }
            });
            return;
        }

        const token =
            request && typeof request === "object" ? request.token : null;

        if (!isValidFcmToken(token)) {
            reply({
                ok: false,
                error: {
                    code: "INVALID_FCM_TOKEN",
                    message: "A valid FCM registration token is required"
                }
            });
            return;
        }

        const identity = socket.data || {};

        try {
            await fcmService.registerToken(
                identity.uid,
                identity.deviceId,
                token
            );

            reply({
                ok: true,
                uid: identity.uid,
                deviceId: identity.deviceId
            });

            // Convenience notification for clients that do not use ACKs.
            socket.emit("android:fcm-registered", {
                ok: true,
                updatedAt: Date.now()
            });

            logger.info("FCM token registered", {
                uid: identity.uid,
                deviceId: identity.deviceId
            });
        } catch (error) {
            logger.error("FCM token registration failed", {
                uid: identity.uid,
                deviceId: identity.deviceId,
                code: error.code,
                message: error.message
            });

            reply({
                ok: false,
                error: {
                    code: "TOKEN_WRITE_FAILED",
                    message: "Could not persist the FCM token"
                }
            });
        }
    });

    socket.on("event:status", (update, ack) => {
        eventService.handleAndroidStatus(socket, update, ack);
    });

    socket.on("event:ack", (request, ack) => {
        eventService.handleAndroidAck(socket, request, ack);
    });
}

module.exports = { registerAndroidHandlers };
