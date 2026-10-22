"use strict";

const { randomUUID } = require("node:crypto");
const {
    validateEventRequest,
    validateStatusUpdate,
    isValidEventId
} = require("../utils/validators");
const {
    STATUS,
    ANDROID_STATUSES,
    isTerminal
} = require("../utils/statusMachine");

function createEventService({
    pendingStore,
    activeSockets,
    delivery,
    fcm,
    rateLimiter,
    config,
    logger
}) {
    function reply(ack, payload) {
        if (typeof ack === "function") {
            ack(payload);
        }
    }

    function errorResponse(code, message, details) {
        return {
            ok: false,
            error: {
                code,
                message,
                ...(details ? { details } : {})
            }
        };
    }

    function socketIdentity(socket) {
        const record = activeSockets.get(socket.id);

        if (record) {
            return {
                uid: record.uid,
                deviceId: record.deviceId,
                clientType: record.clientType
            };
        }

        return {
            uid: socket.data && socket.data.uid,
            deviceId: socket.data && socket.data.deviceId,
            clientType: socket.data && socket.data.clientType
        };
    }

    function pickSocket(sockets) {
        const record = sockets
            .slice()
            .sort((a, b) => {
                const timeA = Number(a.connectedAt) || 0;
                const timeB = Number(b.connectedAt) || 0;

                if (timeA !== timeB) return timeA - timeB;
                return String(a.socketId).localeCompare(String(b.socketId));
            })[0];

        return record ? record.socket : null;
    }

    function pickMostRecentTokenDevice(devices) {
        if (!Array.isArray(devices) || devices.length === 0) return null;

        return devices
            .slice()
            .sort((a, b) => {
                const timeA = Number(a.updatedAt) || 0;
                const timeB = Number(b.updatedAt) || 0;

                if (timeB !== timeA) return timeB - timeA;
                return String(a.deviceId).localeCompare(String(b.deviceId));
            })[0];
    }

    /**
     * Device selection policy:
     * 1. Explicit targetDeviceId -> that device only.
     * 2. No device id -> among this uid's active Android sockets, choose the
     *    lexicographically smallest device id (deterministic). Prefer an
     *    active socket for it.
     * 3. No active socket anywhere -> choose the most recently registered FCM
     *    token (updatedAt desc, deviceId asc as a tie-break).
     *
     * The same work is never broadcast to every device.
     */
    async function resolveTarget(uid, requestedDeviceId) {
        if (requestedDeviceId) {
            const sockets = activeSockets.getDeviceSockets(
                uid,
                requestedDeviceId
            );

            return {
                deviceId: requestedDeviceId,
                socket: sockets.length > 0 ? pickSocket(sockets) : null
            };
        }

        const activeDeviceIds = activeSockets.getActiveDeviceIds(uid);

        if (activeDeviceIds.length > 0) {
            const deviceId = activeDeviceIds[0];
            const sockets = activeSockets.getDeviceSockets(uid, deviceId);

            return {
                deviceId,
                socket: pickSocket(sockets)
            };
        }

        const devices = await fcm.listDevices(uid);
        const chosen = pickMostRecentTokenDevice(devices);

        if (!chosen) return null;

        return {
            deviceId: chosen.deviceId,
            socket: null
        };
    }

    function handleSend(socket, rawRequest, ack) {
        const identity = socketIdentity(socket);

        if (identity.clientType !== "web") {
            reply(
                ack,
                errorResponse(
                    "FORBIDDEN_CLIENT_TYPE",
                    "event:send is only accepted from web clients"
                )
            );
            return;
        }

        if (!rateLimiter.allow(socket, "eventSend")) {
            reply(
                ack,
                errorResponse("RATE_LIMITED", "Too many event:send requests")
            );
            return;
        }

        const validation = validateEventRequest(rawRequest, {
            allowedEventTypes: config.allowedEventTypes,
            payloadMaxBytes: config.eventPayloadMaxBytes
        });

        if (!validation.ok) {
            reply(
                ack,
                errorResponse(
                    "INVALID_EVENT",
                    "Event request validation failed",
                    validation.errors
                )
            );
            return;
        }

        if (pendingStore.isFull()) {
            reply(
                ack,
                errorResponse(
                    "SERVER_BUSY",
                    "In-flight event capacity reached; retry later"
                )
            );
            return;
        }

        const request = validation.value;
        const eventId = randomUUID();
        const acceptedAt = Date.now();

        let event;

        try {
            event = pendingStore.create({
                eventId,
                originSocketId: socket.id,
                targetUid: request.targetUid,
                targetDeviceId: request.targetDeviceId,
                eventType: request.eventType,
                payload: request.payload,
                status: STATUS.ACCEPTED,
                ackReceived: false,
                fallbackAttempted: false,
                targetSocketId: null,
                createdAt: acceptedAt,
                acceptedAt,
                timers: {
                    ack: null,
                    fcmConfirm: null,
                    cleanup: null,
                    lifetime: null
                }
            });
        } catch (error) {
            logger.error("Failed to create in-memory event record", {
                eventId,
                message: error.message
            });
            reply(
                ack,
                errorResponse("INTERNAL_ERROR", "Could not accept event")
            );
            return;
        }

        // The ACK callback only confirms backend acceptance. Android receipt
        // and processing arrive later on the event:status channel.
        reply(ack, {
            ok: true,
            eventId,
            status: STATUS.ACCEPTED,
            acceptedAt
        });

        delivery.notifyAccepted(event);

        logger.info("Web event accepted", {
            eventId,
            originSocketId: socket.id,
            eventType: event.eventType,
            targetUid: event.targetUid,
            targetDeviceId: event.targetDeviceId
        });

        void (async () => {
            try {
                const target = await resolveTarget(
                    event.targetUid,
                    event.targetDeviceId
                );

                if (pendingStore.get(event.eventId) !== event) return;

                if (!target) {
                    delivery.discard(
                        event.eventId,
                        "TARGET_DEVICE_NOT_FOUND"
                    );
                    return;
                }

                event.targetDeviceId = target.deviceId;
                delivery.startDelivery(event, target);
            } catch (error) {
                logger.error("Target resolution failed", {
                    eventId: event.eventId,
                    targetUid: event.targetUid,
                    code: error.code,
                    message: error.message
                });
                delivery.discard(
                    event.eventId,
                    "TARGET_RESOLUTION_FAILED"
                );
            }
        })();
    }

    function validateAndroidEvent(socket, eventId) {
        const identity = socketIdentity(socket);

        if (identity.clientType !== "android") {
            return { ok: false, code: "FORBIDDEN_CLIENT_TYPE" };
        }

        if (!isValidEventId(eventId)) {
            return { ok: false, code: "INVALID_EVENT_ID" };
        }

        const event = pendingStore.get(eventId);

        if (!event) {
            return { ok: false, code: "UNKNOWN_EVENT" };
        }

        if (
            event.targetUid !== identity.uid ||
            !event.targetDeviceId ||
            event.targetDeviceId !== identity.deviceId
        ) {
            return { ok: false, code: "EVENT_NOT_FOR_THIS_DEVICE" };
        }

        if (isTerminal(event.status)) {
            return { ok: false, code: "TERMINAL_STATUS", event };
        }

        return { ok: true, event, identity };
    }

    function handleAndroidStatus(socket, rawUpdate, ack) {
        if (!rateLimiter.allow(socket, "eventStatus")) {
            reply(
                ack,
                errorResponse("RATE_LIMITED", "Too many event:status updates")
            );
            return;
        }

        const validation = validateStatusUpdate(rawUpdate);

        if (!validation.ok) {
            reply(
                ack,
                errorResponse(
                    "INVALID_STATUS_UPDATE",
                    "Status update validation failed",
                    validation.errors
                )
            );
            return;
        }

        const update = validation.value;

        if (!ANDROID_STATUSES.includes(update.status)) {
            reply(
                ack,
                errorResponse(
                    "INVALID_STATUS",
                    `Android may only report: ${ANDROID_STATUSES.join(", ")}`
                )
            );
            return;
        }

        const check = validateAndroidEvent(socket, update.eventId);

        if (!check.ok) {
            reply(ack, errorResponse(check.code, "Status update rejected"));
            return;
        }

        const result = delivery.applyAndroidStatus(check.event, update.status, {
            message: update.message
        });

        if (!result.ok) {
            reply(
                ack,
                errorResponse(result.code, "Status transition rejected", {
                    currentStatus: result.status
                })
            );
            return;
        }

        reply(ack, {
            ok: true,
            eventId: update.eventId,
            status: result.status
        });
    }

    function handleAndroidAck(socket, rawRequest, ack) {
        if (!rateLimiter.allow(socket, "eventStatus")) {
            reply(
                ack,
                errorResponse("RATE_LIMITED", "Too many ACK messages")
            );
            return;
        }

        const eventId =
            rawRequest && typeof rawRequest === "object"
                ? rawRequest.eventId
                : null;
        const check = validateAndroidEvent(socket, eventId);

        if (!check.ok) {
            reply(ack, errorResponse(check.code, "ACK rejected"));
            return;
        }

        delivery.markReceipt(check.event.eventId, "event:ack");

        reply(ack, {
            ok: true,
            eventId: check.event.eventId,
            status: check.event.status
        });
    }

    return {
        handleSend,
        handleAndroidStatus,
        handleAndroidAck,
        resolveTarget
    };
}

module.exports = { createEventService };
