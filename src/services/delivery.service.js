"use strict";

const {
    STATUS,
    canTransition,
    isTerminal
} = require("../utils/statusMachine");

/**
 * Delivery orchestrator.
 *
 * Lifecycle for one event:
 *   ACCEPTED -> SENT_WS -> RECEIVED -> PROCESSING -> COMPLETED | FAILED
 *                     \-> FCM_ATTEMPTED -> FCM_ACCEPTED -> RECEIVED -> ...
 *                                      \-> DISCARDED
 *                                                     \-> DELIVERY_UNCONFIRMED
 *
 * `fallbackOnce` is the only place that starts an FCM attempt. It flips the
 * `fallbackAttempted` flag synchronously before any await, which makes the
 * timeout/disconnect race safe inside a single Node.js process.
 */
function createDeliveryService({
    pendingStore,
    activeSockets,
    fcm,
    notify,
    config,
    logger
}) {
    const ackTimeoutMs = config.ackTimeoutMs;
    const postFcmConfirmTimeoutMs = config.postFcmConfirmTimeoutMs;
    const cleanupGraceMs = config.eventCleanupGraceMs;
    const hardTimeoutMs = config.eventHardTimeoutMs;

    function ensureTimers(event) {
        if (!event.timers) {
            event.timers = {
                ack: null,
                fcmConfirm: null,
                cleanup: null,
                lifetime: null
            };
        }

        return event.timers;
    }

    function clearTimer(event, name) {
        const timers = ensureTimers(event);

        if (timers[name]) {
            clearTimeout(timers[name]);
            timers[name] = null;
        }
    }

    function setTimer(event, name, callback, delay) {
        clearTimer(event, name);

        const handle = setTimeout(() => {
            event.timers[name] = null;
            callback();
        }, delay);

        if (typeof handle.unref === "function") {
            handle.unref();
        }

        event.timers[name] = handle;
        return handle;
    }

    function notifyStatus(event, status, extra = {}) {
        const payload = {
            eventId: event.eventId,
            status,
            eventType: event.eventType,
            targetUid: event.targetUid,
            targetDeviceId: event.targetDeviceId,
            timestamp: Date.now(),
            ...extra
        };

        return notify(event.originSocketId, payload);
    }

    function notifyAccepted(event) {
        return notifyStatus(event, STATUS.ACCEPTED, { source: "backend" });
    }

    function transition(event, nextStatus, extra = {}) {
        if (!canTransition(event.status, nextStatus)) {
            logger.warn("Rejected event status transition", {
                eventId: event.eventId,
                from: event.status,
                to: nextStatus
            });
            return false;
        }

        event.status = nextStatus;
        notifyStatus(event, nextStatus, extra);
        return true;
    }

    function scheduleCleanup(event) {
        if (event.timers.cleanup) return;

        setTimer(
            event,
            "cleanup",
            () => {
                pendingStore.delete(event.eventId);
                logger.debug("In-flight event metadata removed", {
                    eventId: event.eventId
                });
            },
            cleanupGraceMs
        );
    }

    function finish(event, status, extra = {}) {
        if (pendingStore.get(event.eventId) !== event) return false;

        if (isTerminal(event.status)) {
            logger.debug("Ignoring terminal status on already terminal event", {
                eventId: event.eventId,
                currentStatus: event.status,
                attemptedStatus: status
            });
            return false;
        }

        if (!canTransition(event.status, status)) {
            logger.warn("Cannot finish event with requested status", {
                eventId: event.eventId,
                currentStatus: event.status,
                attemptedStatus: status
            });
            return false;
        }

        event.status = status;
        event.terminalAt = Date.now();
        clearTimer(event, "ack");
        clearTimer(event, "fcmConfirm");
        clearTimer(event, "lifetime");
        event.payload = null;
        notifyStatus(event, status, extra);
        scheduleCleanup(event);
        return true;
    }

    function discard(eventId, reason, extra = {}) {
        const event = pendingStore.get(eventId);

        if (!event) return false;

        return finish(event, STATUS.DISCARDED, { reason, ...extra });
    }

    function isReceiptAck(response) {
        if (!response) return false;
        if (typeof response === "string") return response === STATUS.RECEIVED;
        if (typeof response === "object") return response.status === STATUS.RECEIVED;
        return false;
    }

    function markReceipt(eventId, source) {
        const event = pendingStore.get(eventId);

        if (!event) return false;
        if (event.ackReceived) return false;

        event.ackReceived = true;
        event.receiptAckAt = Date.now();
        clearTimer(event, "ack");
        event.payload = null;

        // FCM wait is over; a live application-level receipt is stronger.
        clearTimer(event, "fcmConfirm");

        if (isTerminal(event.status)) {
            scheduleCleanup(event);
            return true;
        }

        if (event.status !== STATUS.RECEIVED) {
            if (!canTransition(event.status, STATUS.RECEIVED)) {
                logger.warn("Receipt ACK arrived but status cannot transition", {
                    eventId,
                    currentStatus: event.status,
                    source
                });
                return true;
            }

            event.status = STATUS.RECEIVED;
            notifyStatus(event, STATUS.RECEIVED, { source });
        }

        return true;
    }

    function onAckTimeout(eventId) {
        const event = pendingStore.get(eventId);

        if (!event) return;
        if (event.ackReceived) return;

        logger.info("Receipt ACK timeout reached", {
            eventId,
            targetDeviceId: event.targetDeviceId
        });

        fallbackOnce(eventId, "ACK_TIMEOUT");
    }

    function onFcmConfirmTimeout(eventId) {
        const event = pendingStore.get(eventId);

        if (!event) return;
        if (event.ackReceived) return;
        if (isTerminal(event.status)) return;

        logger.info("Post-FCM confirmation window expired", {
            eventId,
            targetDeviceId: event.targetDeviceId
        });

        finish(event, STATUS.DELIVERY_UNCONFIRMED, {
            reason: "POST_FCM_CONFIRM_TIMEOUT"
        });
    }

    function scheduleFcmConfirmation(event) {
        if (event.timers.fcmConfirm) return;

        setTimer(
            event,
            "fcmConfirm",
            () => onFcmConfirmTimeout(event.eventId),
            postFcmConfirmTimeoutMs
        );
    }

    function armHardLifetime(event) {
        if (event.timers.lifetime) return;

        setTimer(
            event,
            "lifetime",
            () => {
                if (pendingStore.get(event.eventId) !== event) return;

                logger.warn("In-flight event hard timeout reached; dropping record", {
                    eventId: event.eventId,
                    status: event.status
                });

                pendingStore.delete(event.eventId);
            },
            hardTimeoutMs
        );
    }

    function pickMostRecentDevice(devices) {
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

    async function runFcmFallback(event, payload, reason) {
        try {
            let deviceId = event.targetDeviceId;

            if (!deviceId) {
                const devices = await fcm.listDevices(event.targetUid);
                const chosen = pickMostRecentDevice(devices);

                if (!chosen) {
                    discard(event.eventId, "TARGET_DEVICE_NOT_FOUND");
                    return;
                }

                deviceId = chosen.deviceId;
                event.targetDeviceId = deviceId;
            }

            if (pendingStore.get(event.eventId) !== event) return;

            const token = await fcm.getToken(event.targetUid, deviceId);

            if (!token) {
                logger.warn("FCM fallback discarded: token missing", {
                    eventId: event.eventId,
                    targetDeviceId: deviceId
                });
                discard(event.eventId, "FCM_TOKEN_MISSING", {
                    fcmErrorCode: "TOKEN_MISSING"
                });
                return;
            }

            await fcm.sendEvent({
                token,
                eventId: event.eventId,
                eventType: event.eventType,
                targetUid: event.targetUid,
                targetDeviceId: deviceId,
                payload
            });

            if (pendingStore.get(event.eventId) !== event) return;

            // A late Socket.IO ACK may have arrived while messaging.send was
            // in flight. In that case the app already received the event, so
            // do not downgrade the accurate RECEIVED status to FCM_ACCEPTED.
            if (event.ackReceived) {
                // A late Socket.IO ACK won the race. Keep the record so the
                // Android app can still report PROCESSING/COMPLETED; the hard
                // lifetime timer remains the safety valve.
                return;
            }

            if (isTerminal(event.status)) return;

            if (transition(event, STATUS.FCM_ACCEPTED, { reason })) {
                scheduleFcmConfirmation(event);
            }
        } catch (error) {
            if (pendingStore.get(event.eventId) !== event) return;

            logger.error("FCM fallback attempt failed", {
                eventId: event.eventId,
                targetDeviceId: event.targetDeviceId,
                code: error.code,
                message: error.message
            });

            if (event.ackReceived) {
                // Receipt already confirmed over Socket.IO; nothing to retry.
                return;
            }

            discard(event.eventId, "FCM_SEND_FAILED", {
                fcmErrorCode: error.code || "FCM_ERROR"
            });
        }
    }

    /**
     * Exactly one application-level FCM attempt per event.
     * The flag is set synchronously before any asynchronous work.
     */
    function fallbackOnce(eventId, reason) {
        const event = pendingStore.get(eventId);

        if (!event) return false;
        if (event.fallbackAttempted) return false;
        if (event.ackReceived) return false;
        if (isTerminal(event.status)) return false;

        event.fallbackAttempted = true;
        event.fallbackReason = reason;
        event.targetSocketId = null;

        clearTimer(event, "ack");

        const payload = event.payload;
        event.payload = null;

        if (!transition(event, STATUS.FCM_ATTEMPTED, { reason })) {
            return false;
        }

        logger.info("Starting the single FCM fallback attempt", {
            eventId,
            reason,
            targetUid: event.targetUid,
            targetDeviceId: event.targetDeviceId
        });

        // Intentionally not awaited. Delivery is best-effort and nothing is
        // serialized or retried.
        void runFcmFallback(event, payload, reason);

        return true;
    }

    function startDelivery(event, target) {
        armHardLifetime(event);

        event.targetDeviceId = target.deviceId;

        if (!target.socket) {
            event.targetSocketId = null;
            fallbackOnce(event.eventId, "NO_ACTIVE_SOCKET");
            return;
        }

        event.targetSocketId = target.socket.id;

        if (!transition(event, STATUS.SENT_WS, { transport: "socket.io" })) {
            return;
        }

        const deliverPayload = {
            eventId: event.eventId,
            eventType: event.eventType,
            targetUid: event.targetUid,
            targetDeviceId: target.deviceId,
            payload: event.payload,
            sentAt: Date.now()
        };

        setTimer(
            event,
            "ack",
            () => onAckTimeout(event.eventId),
            ackTimeoutMs
        );

        try {
            target.socket.emit(
                "event:deliver",
                deliverPayload,
                (response) => {
                    if (isReceiptAck(response)) {
                        markReceipt(event.eventId, "socket-ack-callback");
                    }
                }
            );
        } catch (error) {
            logger.error("Socket.IO delivery emit failed", {
                eventId: event.eventId,
                targetSocketId: target.socket.id,
                code: error.code,
                message: error.message
            });
            fallbackOnce(event.eventId, "WS_EMIT_FAILED");
        }
    }

    function applyAndroidStatus(event, status, extra = {}) {
        if (pendingStore.get(event.eventId) !== event) {
            return { ok: false, code: "UNKNOWN_EVENT" };
        }

        if (status === STATUS.RECEIVED) {
            const changed = markReceipt(event.eventId, "android-status");
            return {
                ok: true,
                status: event.status,
                changed
            };
        }

        if (isTerminal(event.status)) {
            return {
                ok: false,
                code: "TERMINAL_STATUS",
                status: event.status
            };
        }

        if (!canTransition(event.status, status)) {
            return {
                ok: false,
                code: "INVALID_STATUS_TRANSITION",
                status: event.status
            };
        }

        // Any accepted app-level progress proves the application received the
        // event, even if the explicit RECEIVED packet was lost. This stops the
        // post-FCM confirmation timer from later reporting DELIVERY_UNCONFIRMED.
        event.ackReceived = true;
        event.receiptAckAt = event.receiptAckAt || Date.now();
        clearTimer(event, "ack");
        clearTimer(event, "fcmConfirm");
        event.payload = null;

        event.status = status;
        notifyStatus(event, status, { source: "android", ...extra });

        if (isTerminal(status)) {
            event.terminalAt = Date.now();
            clearTimer(event, "ack");
            clearTimer(event, "fcmConfirm");
            clearTimer(event, "lifetime");
            event.payload = null;
            scheduleCleanup(event);
        }

        return { ok: true, status: event.status, changed: true };
    }

    function handleSocketDisconnect(socketId) {
        const affected = [];

        for (const event of pendingStore.values()) {
            if (
                event.targetSocketId === socketId &&
                !event.ackReceived &&
                !event.fallbackAttempted &&
                !isTerminal(event.status)
            ) {
                affected.push(event.eventId);
            }
        }

        for (const eventId of affected) {
            logger.info("Target socket disconnected before ACK; falling back", {
                eventId,
                socketId
            });
            fallbackOnce(eventId, "WS_DISCONNECTED");
        }

        return affected.length;
    }

    function shutdown() {
        pendingStore.clearAll();
    }

    return {
        startDelivery,
        notifyAccepted,
        discard,
        markReceipt,
        fallbackOnce,
        applyAndroidStatus,
        handleSocketDisconnect,
        shutdown
    };
}

module.exports = { createDeliveryService };
