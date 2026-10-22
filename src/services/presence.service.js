"use strict";

/**
 * Presence is authoritative in memory: a device is online while at least one
 * Android Socket.IO connection for that (uid, deviceId) is attached to this
 * process. RTDB is an observational mirror that lets other clients and
 * operators see the last known state.
 */
function createPresenceService({
    activeSockets,
    db,
    config,
    logger,
    sendToSocket,
    serverTimestamp,
    now = () => Date.now()
}) {
    // socketId -> Set<uid>
    const watchedUidsBySocket = new Map();
    // uid -> Set<socketId>
    const watchersByUid = new Map();
    // `${uid}:${deviceId}` -> last RTDB heartbeat write timestamp
    const lastHeartbeatWrite = new Map();
    // `${uid}:${deviceId}` -> promise chain, keeps connect/disconnect/heartbeat
    // writes for one device strictly ordered even when they overlap.
    const deviceWriteChains = new Map();

    function queueDeviceWrite(key, task) {
        const previous = deviceWriteChains.get(key) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(task)
            .finally(() => {
                if (deviceWriteChains.get(key) === next) {
                    deviceWriteChains.delete(key);
                }
            });

        deviceWriteChains.set(key, next);
        return next;
    }

    function deviceKey(uid, deviceId) {
        return `${uid}\u0000${deviceId}`;
    }

    function presencePath(uid, deviceId) {
        return `presence/${uid}/devices/${deviceId}`;
    }

    function timestampOrZero(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }

    function isFresh(deviceRecord, currentTime) {
        const lastSignal = Math.max(
            timestampOrZero(deviceRecord.lastHeartbeatAt),
            timestampOrZero(deviceRecord.updatedAt),
            timestampOrZero(deviceRecord.lastSeen)
        );

        if (lastSignal === 0) return false;

        return currentTime - lastSignal <= config.presenceStaleMs;
    }

    function onlineDevicesFromMemory(uid) {
        return activeSockets.getActiveDeviceIds(uid).map((deviceId) => ({
            deviceId,
            online: true,
            source: "socket",
            connectionCount: activeSockets.countDeviceSockets(uid, deviceId)
        }));
    }

    function getUserPresence(uid) {
        const devices = onlineDevicesFromMemory(uid);

        return {
            uid,
            online: devices.length > 0,
            devices,
            source: "socket",
            checkedAt: now()
        };
    }

    function notifyWatchers(uid, update) {
        const watchers = watchersByUid.get(uid);

        if (!watchers || watchers.size === 0) return 0;

        let delivered = 0;

        for (const socketId of watchers) {
            if (sendToSocket(socketId, "presence:update", update)) {
                delivered += 1;
            }
        }

        return delivered;
    }

    async function handleAndroidConnect(socket) {
        const record = activeSockets.get(socket.id);

        if (!record || record.clientType !== "android") return;

        const connectionCount = activeSockets.countDeviceSockets(
            record.uid,
            record.deviceId
        );

        const update = {
            uid: record.uid,
            deviceId: record.deviceId,
            status: "online",
            connectionCount,
            lastConnectedAt: serverTimestamp ?? null,
            lastSeen: serverTimestamp ?? null,
            lastHeartbeatAt: serverTimestamp ?? null,
            updatedAt: serverTimestamp ?? null,
            stale: false,
            offlineReason: null
        };

        try {
            const key = deviceKey(record.uid, record.deviceId);
            await queueDeviceWrite(key, () =>
                db.ref(presencePath(record.uid, record.deviceId)).update(update)
            );
        } catch (error) {
            logger.error("Failed to write online presence to RTDB", {
                uid: record.uid,
                deviceId: record.deviceId,
                code: error.code,
                message: error.message
            });
        }

        notifyWatchers(record.uid, {
            uid: record.uid,
            deviceId: record.deviceId,
            online: true,
            connectionCount,
            source: "socket",
            timestamp: now()
        });
    }

    async function handleAndroidDisconnect(socketOrRecord) {
        const record =
            socketOrRecord && socketOrRecord.clientType
                ? socketOrRecord
                : activeSockets.get(socketOrRecord.id);

        if (!record || record.clientType !== "android") return;

        const remaining = activeSockets.countDeviceSockets(
            record.uid,
            record.deviceId
        );

        // Another socket for the same device is still connected: stay online.
        if (remaining > 0) {
            try {
                const key = deviceKey(record.uid, record.deviceId);
                await queueDeviceWrite(key, () =>
                    db
                        .ref(presencePath(record.uid, record.deviceId))
                        .update({
                            connectionCount: remaining,
                            lastSeen: serverTimestamp ?? null,
                            updatedAt: serverTimestamp ?? null
                        })
                );
            } catch (error) {
                logger.error("Failed to update presence connection count", {
                    uid: record.uid,
                    deviceId: record.deviceId,
                    code: error.code,
                    message: error.message
                });
            }

            notifyWatchers(record.uid, {
                uid: record.uid,
                deviceId: record.deviceId,
                online: true,
                connectionCount: remaining,
                source: "socket",
                timestamp: now()
            });

            return;
        }

        try {
            const key = deviceKey(record.uid, record.deviceId);
            await queueDeviceWrite(key, () =>
                db
                    .ref(presencePath(record.uid, record.deviceId))
                    .update({
                        status: "offline",
                        connectionCount: 0,
                        lastSeen: serverTimestamp ?? null,
                        updatedAt: serverTimestamp ?? null,
                        stale: false,
                        offlineReason: "socket-disconnected"
                    })
            );
            lastHeartbeatWrite.delete(key);
        } catch (error) {
            logger.error("Failed to write offline presence to RTDB", {
                uid: record.uid,
                deviceId: record.deviceId,
                code: error.code,
                message: error.message
            });
        }

        notifyWatchers(record.uid, {
            uid: record.uid,
            deviceId: record.deviceId,
            online: false,
            connectionCount: 0,
            source: "socket",
            timestamp: now()
        });
    }

    async function handleHeartbeat(socket) {
        const record = activeSockets.get(socket.id);

        if (!record || record.clientType !== "android") {
            return { ok: false, reason: "NOT_ANDROID" };
        }

        const current = now();
        record.lastHeartbeatAt = current;
        record.lastSeen = current;

        const key = deviceKey(record.uid, record.deviceId);
        const lastWrite = lastHeartbeatWrite.get(key) || 0;

        if (current - lastWrite < config.presenceHeartbeatWriteMs) {
            return { ok: true, persisted: false };
        }

        lastHeartbeatWrite.set(key, current);

        try {
            await queueDeviceWrite(key, () =>
                db
                    .ref(presencePath(record.uid, record.deviceId))
                    .update({
                        status: "online",
                        lastHeartbeatAt: serverTimestamp ?? null,
                        lastSeen: serverTimestamp ?? null,
                        updatedAt: serverTimestamp ?? null,
                        stale: false
                    })
            );
        } catch (error) {
            logger.error("Failed to persist presence heartbeat", {
                uid: record.uid,
                deviceId: record.deviceId,
                code: error.code,
                message: error.message
            });
            return { ok: false, reason: "RTDB_WRITE_FAILED" };
        }

        return { ok: true, persisted: true };
    }

    async function getPresenceSnapshot(uid) {
        const memory = getUserPresence(uid);

        if (memory.online) {
            return memory;
        }

        let snapshot;

        try {
            snapshot = await db.ref(`presence/${uid}`).once("value");
        } catch (error) {
            logger.error("Failed to read presence from RTDB", {
                uid,
                code: error.code,
                message: error.message
            });
            return memory;
        }

        if (!snapshot.exists()) {
            return {
                uid,
                online: false,
                devices: [],
                source: "none",
                checkedAt: now()
            };
        }

        const value = snapshot.val() || {};
        const rtDeviceRecords =
            value.devices && typeof value.devices === "object"
                ? value.devices
                : {};

        const current = now();
        const devices = [];

        for (const [deviceId, deviceRecord] of Object.entries(rtDeviceRecords)) {
            if (!deviceRecord || typeof deviceRecord !== "object") continue;

            const rawOnline = deviceRecord.status === "online";
            const fresh = isFresh(deviceRecord, current);

            // No live Socket.IO connection exists in this process, so the
            // device is NOT online for delivery purposes. The RTDB record is
            // informational only; freshness tells us whether the last write
            // is recent enough to be worth displaying.
            devices.push({
                deviceId,
                online: false,
                reportedOnline: rawOnline,
                stale: rawOnline && !fresh,
                source: "rtdb",
                lastKnownStatus:
                    typeof deviceRecord.status === "string"
                        ? deviceRecord.status
                        : null,
                lastSeen: timestampOrZero(deviceRecord.lastSeen) || null,
                lastConnectedAt:
                    timestampOrZero(deviceRecord.lastConnectedAt) || null,
                lastHeartbeatAt:
                    timestampOrZero(deviceRecord.lastHeartbeatAt) || null
            });
        }

        return {
            uid,
            online: false,
            devices,
            source: "rtdb",
            checkedAt: current
        };
    }

    async function watch(socketId, uid) {
        if (!watchedUidsBySocket.has(socketId)) {
            watchedUidsBySocket.set(socketId, new Set());
        }

        watchedUidsBySocket.get(socketId).add(uid);

        if (!watchersByUid.has(uid)) {
            watchersByUid.set(uid, new Set());
        }

        watchersByUid.get(uid).add(socketId);

        const snapshot = await getPresenceSnapshot(uid);

        sendToSocket(socketId, "presence:status", snapshot);

        return snapshot;
    }

    function unwatch(socketId, uid) {
        const uids = watchedUidsBySocket.get(socketId);

        if (uids) {
            uids.delete(uid);

            if (uids.size === 0) {
                watchedUidsBySocket.delete(socketId);
            }
        }

        const watchers = watchersByUid.get(uid);

        if (watchers) {
            watchers.delete(socketId);

            if (watchers.size === 0) {
                watchersByUid.delete(uid);
            }
        }
    }

    function removeSocket(socketId) {
        const uids = watchedUidsBySocket.get(socketId);

        if (!uids) return;

        for (const uid of uids) {
            const watchers = watchersByUid.get(uid);

            if (watchers) {
                watchers.delete(socketId);

                if (watchers.size === 0) {
                    watchersByUid.delete(uid);
                }
            }
        }

        watchedUidsBySocket.delete(socketId);
    }

    /**
     * Single-instance startup reconciliation.
     *
     * On boot there are no sockets attached to this process yet, so any
     * leftover "online" entry is stale. We mark it offline instead of trusting
     * it. With multiple instances this strategy must be replaced by a
     * heartbeat lease with instance ownership.
     */
    async function reconcileOnStart() {
        let snapshot;

        try {
            snapshot = await db.ref("presence").once("value");
        } catch (error) {
            logger.error("Presence reconciliation could not read RTDB", {
                code: error.code,
                message: error.message
            });
            return 0;
        }

        if (!snapshot.exists()) return 0;

        const value = snapshot.val() || {};
        const updates = {};
        let count = 0;

        for (const [uid, userRecord] of Object.entries(value)) {
            if (
                !userRecord ||
                typeof userRecord !== "object" ||
                !userRecord.devices
            ) {
                continue;
            }

            for (const [deviceId, deviceRecord] of Object.entries(
                userRecord.devices
            )) {
                if (
                    deviceRecord &&
                    typeof deviceRecord === "object" &&
                    deviceRecord.status === "online"
                ) {
                    const base = `presence/${uid}/devices/${deviceId}`;
                    updates[`${base}/status`] = "offline";
                    updates[`${base}/connectionCount`] = 0;
                    updates[`${base}/updatedAt`] =
                        serverTimestamp ?? null;
                    updates[`${base}/lastSeen`] = serverTimestamp ?? null;
                    updates[`${base}/stale`] = true;
                    updates[`${base}/offlineReason`] = "server-restart";
                    count += 1;
                }
            }
        }

        if (count === 0) return 0;

        try {
            await db.ref().update(updates);
            logger.info("Presence reconciliation completed", {
                offlineDevices: count
            });
        } catch (error) {
            logger.error("Presence reconciliation write failed", {
                code: error.code,
                message: error.message
            });
            return 0;
        }

        return count;
    }

    return {
        getUserPresence,
        isUserOnline: (uid) => activeSockets.isUserOnline(uid),
        getPresenceSnapshot,
        watch,
        unwatch,
        removeSocket,
        handleAndroidConnect,
        handleAndroidDisconnect,
        handleHeartbeat,
        reconcileOnStart
    };
}

module.exports = { createPresenceService };
