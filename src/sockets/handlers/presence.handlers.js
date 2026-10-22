"use strict";

const { isValidUid } = require("../../utils/validators");

function registerPresenceHandlers(socket, deps) {
    const { presenceService, rateLimiter } = deps;

    socket.on("presence:watch", async (request, ack) => {
        const reply =
            typeof ack === "function" ? ack : () => undefined;

        if (!rateLimiter.allow(socket, "presence")) {
            reply({
                ok: false,
                error: { code: "RATE_LIMITED", message: "Too many presence requests" }
            });
            return;
        }

        const uid = request && typeof request === "object" ? request.uid : null;

        if (!isValidUid(uid)) {
            reply({
                ok: false,
                error: { code: "INVALID_UID", message: "A valid uid is required" }
            });
            return;
        }

        const snapshot = await presenceService.watch(socket.id, uid);

        reply({ ok: true, ...snapshot });
    });

    socket.on("presence:unwatch", (request, ack) => {
        const reply =
            typeof ack === "function" ? ack : () => undefined;

        if (!rateLimiter.allow(socket, "presence")) {
            reply({
                ok: false,
                error: { code: "RATE_LIMITED", message: "Too many presence requests" }
            });
            return;
        }

        const uid = request && typeof request === "object" ? request.uid : null;

        if (!isValidUid(uid)) {
            reply({
                ok: false,
                error: { code: "INVALID_UID", message: "A valid uid is required" }
            });
            return;
        }

        presenceService.unwatch(socket.id, uid);

        reply({ ok: true, uid });
    });

    socket.on("presence:heartbeat", (request, ack) => {
        const reply =
            typeof ack === "function" ? ack : () => undefined;

        if (!rateLimiter.allow(socket, "heartbeat")) {
            reply({
                ok: false,
                error: { code: "RATE_LIMITED", message: "Too many heartbeats" }
            });
            return;
        }

        presenceService
            .handleHeartbeat(socket)
            .then((result) => reply(result))
            .catch((error) => {
                reply({ ok: false, reason: "HEARTBEAT_FAILED" });
                void error;
            });
    });
}

module.exports = { registerPresenceHandlers };
