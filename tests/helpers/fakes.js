"use strict";

const { createLogger } = require("../../src/utils/logger");
const { createFcmService } = require("../../src/services/fcm.service");

const silentLogger = createLogger({ level: "silent" });

const TEST_TOKEN =
    "fcm-test-token-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function splitPath(path) {
    return String(path)
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
}

function getPath(root, path) {
    let cursor = root;

    for (const part of splitPath(path)) {
        if (cursor === null || typeof cursor !== "object") return undefined;
        cursor = cursor[part];
    }

    return cursor;
}

function setPath(root, path, value) {
    const parts = splitPath(path);

    if (parts.length === 0) return;

    let cursor = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];

        if (
            cursor[part] === null ||
            typeof cursor[part] !== "object" ||
            Array.isArray(cursor[part])
        ) {
            cursor[part] = {};
        }

        cursor = cursor[part];
    }

    const last = parts[parts.length - 1];

    if (value === undefined) {
        delete cursor[last];
        return;
    }

    cursor[last] = clone(value);
}

function createFakeDb(initial = {}) {
    const data = clone(initial) || {};
    const writes = [];

    function ref(path) {
        return {
            async once(event) {
                if (event !== undefined && event !== "value") {
                    throw new Error(`Unsupported once event: ${event}`);
                }

                const value = getPath(data, path);

                return {
                    exists: () => value !== undefined && value !== null,
                    val: () => clone(value)
                };
            },
            async set(value) {
                writes.push({ method: "set", path, value: clone(value) });
                setPath(data, path, value);
            },
            async update(values) {
                writes.push({ method: "update", path, value: clone(values) });

                for (const [key, value] of Object.entries(values)) {
                    const fullPath = path ? `${path}/${key}` : key;
                    setPath(data, fullPath, value);
                }
            },
            async remove() {
                writes.push({ method: "remove", path });
                setPath(data, path, undefined);
            }
        };
    }

    return {
        ref,
        __data: data,
        __writes: writes
    };
}

function createFakeMessaging(options = {}) {
    const sent = [];
    let shouldFail = Boolean(options.fail);

    return {
        sent,
        get callCount() {
            return sent.length;
        },
        setFail(value) {
            shouldFail = Boolean(value);
        },
        async send(message) {
            sent.push(clone(message));

            if (shouldFail) {
                const error = new Error("Mock FCM failure");
                error.code = options.errorCode || "messaging/unavailable";
                throw error;
            }

            return `projects/test-project/messages/${sent.length}`;
        }
    };
}

function createTestFcm({
    db = createFakeDb(),
    messaging = createFakeMessaging(),
    serverTimestamp = 1700000000000
} = {}) {
    const service = createFcmService({
        db,
        messaging,
        serverTimestamp,
        logger: silentLogger
    });

    return { service, db, messaging };
}

function createNotifier({ isOnline = () => true } = {}) {
    const deliveries = [];

    function notify(socketId, payload) {
        if (!isOnline(socketId)) return false;

        deliveries.push({ socketId, payload });
        return true;
    }

    notify.deliveries = deliveries;
    notify.statuses = () => deliveries.map((entry) => entry.payload.status);
    notify.forSocket = (socketId) =>
        deliveries.filter((entry) => entry.socketId === socketId);

    return notify;
}

function createFakeSocket(id, data = {}) {
    const socket = {
        id,
        data,
        emitted: [],
        emit(eventName, payload, ack) {
            socket.emitted.push({ eventName, payload });

            if (eventName === "event:deliver" && typeof ack === "function") {
                socket.deliverAck = ack;
            }

            return true;
        }
    };

    return socket;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenDatabase(uid, deviceId, token = TEST_TOKEN) {
    return {
        fcmTokens: {
            [uid]: {
                [deviceId]: {
                    token,
                    updatedAt: 1700000000000
                }
            }
        }
    };
}

module.exports = {
    TEST_TOKEN,
    silentLogger,
    clone,
    createFakeDb,
    createFakeMessaging,
    createTestFcm,
    createNotifier,
    createFakeSocket,
    sleep,
    tokenDatabase
};
