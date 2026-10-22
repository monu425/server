"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ActiveSocketsStore } = require("../src/stores/activeSockets.store");
const {
    createPresenceService
} = require("../src/services/presence.service");
const { testConfig } = require("./helpers/fixtures");
const {
    createFakeDb,
    createFakeSocket,
    silentLogger
} = require("./helpers/fakes");

function createPresenceHarness(options = {}) {
    const db = options.db || createFakeDb();
    const activeSockets = options.activeSockets || new ActiveSocketsStore();
    const config = { ...testConfig, ...(options.config || {}) };
    const messages = [];

    const sendToSocket = (socketId, eventName, payload) => {
        messages.push({ socketId, eventName, payload });
        return true;
    };

    const presence = createPresenceService({
        activeSockets,
        db,
        config,
        logger: silentLogger,
        sendToSocket,
        serverTimestamp: 777,
        now: options.now || (() => Date.now())
    });

    return { db, activeSockets, config, messages, sendToSocket, presence };
}

function addAndroid(activeSockets, id, uid = "uid-1", deviceId = "device-1") {
    const socket = createFakeSocket(id, {
        clientType: "android",
        uid,
        deviceId
    });

    const record = activeSockets.add({
        socketId: id,
        socket,
        clientType: "android",
        uid,
        deviceId,
        connectedAt: Date.now()
    });

    return { socket, record };
}

function writesWithValue(db, predicate) {
    return db.__writes.filter((write) => {
        if (!write.value || typeof write.value !== "object") return false;

        return Object.values(write.value).some(predicate);
    });
}

test("connect writes online presence and disconnect writes offline presence", async () => {
    const harness = createPresenceHarness();
    const { socket, record } = addAndroid(
        harness.activeSockets,
        "android-1"
    );

    await harness.presence.watch("web-watcher", "uid-1");

    await harness.presence.handleAndroidConnect(socket);

    const onlineRecord =
        harness.db.__data.presence["uid-1"].devices["device-1"];
    assert.equal(onlineRecord.status, "online");
    assert.equal(onlineRecord.connectionCount, 1);
    assert.equal(onlineRecord.updatedAt, 777);

    const onlineUpdate = harness.messages.find(
        (entry) =>
            entry.eventName === "presence:update" &&
            entry.payload.online === true
    );
    assert.ok(onlineUpdate);
    assert.equal(onlineUpdate.socketId, "web-watcher");

    harness.activeSockets.remove("android-1");
    await harness.presence.handleAndroidDisconnect(record);

    const offlineRecord =
        harness.db.__data.presence["uid-1"].devices["device-1"];
    assert.equal(offlineRecord.status, "offline");
    assert.equal(offlineRecord.connectionCount, 0);
    assert.equal(offlineRecord.offlineReason, "socket-disconnected");

    const offlineUpdate = harness.messages.find(
        (entry) =>
            entry.eventName === "presence:update" &&
            entry.payload.online === false
    );
    assert.ok(offlineUpdate);
});

test("a device stays online while another socket for the same device is active", async () => {
    const harness = createPresenceHarness();
    const first = addAndroid(harness.activeSockets, "android-1");
    addAndroid(harness.activeSockets, "android-2");

    harness.activeSockets.remove("android-1");
    await harness.presence.handleAndroidDisconnect(first.record);

    assert.equal(
        harness.activeSockets.isDeviceOnline("uid-1", "device-1"),
        true
    );
    assert.equal(
        writesWithValue(harness.db, (value) => value === "offline").length,
        0
    );

    const second = harness.activeSockets.get("android-2");
    harness.activeSockets.remove("android-2");
    await harness.presence.handleAndroidDisconnect(second);

    assert.equal(
        harness.activeSockets.isDeviceOnline("uid-1", "device-1"),
        false
    );
    assert.equal(
        writesWithValue(harness.db, (value) => value === "offline").length,
        1
    );
});

test("a user is online when at least one device is online", () => {
    const harness = createPresenceHarness();

    addAndroid(harness.activeSockets, "android-1", "uid-1", "device-1");
    addAndroid(harness.activeSockets, "android-2", "uid-1", "device-2");

    assert.equal(harness.presence.isUserOnline("uid-1"), true);
    assert.deepEqual(harness.activeSockets.getActiveDeviceIds("uid-1"), [
        "device-1",
        "device-2"
    ]);

    harness.activeSockets.remove("android-1");
    assert.equal(harness.presence.isUserOnline("uid-1"), true);

    harness.activeSockets.remove("android-2");
    assert.equal(harness.presence.isUserOnline("uid-1"), false);
});

test("stale RTDB online entries are not treated as trustworthy", async () => {
    const NOW = 1_000_000;
    const db = createFakeDb({
        presence: {
            "uid-1": {
                devices: {
                    "device-1": {
                        status: "online",
                        lastHeartbeatAt: NOW - 500000,
                        updatedAt: NOW - 500000,
                        lastSeen: NOW - 500000
                    }
                }
            }
        }
    });

    const harness = createPresenceHarness({
        db,
        now: () => NOW,
        config: { presenceStaleMs: 1000 }
    });

    const snapshot = await harness.presence.getPresenceSnapshot("uid-1");

    assert.equal(snapshot.online, false);
    assert.equal(snapshot.source, "rtdb");
    assert.equal(snapshot.devices[0].stale, true);
    assert.equal(snapshot.devices[0].online, false);
});

test("fresh RTDB presence is not promoted to authoritative online", async () => {
    const NOW = 1_000_000;
    const db = createFakeDb({
        presence: {
            "uid-1": {
                devices: {
                    "device-1": {
                        status: "online",
                        lastHeartbeatAt: NOW - 500,
                        updatedAt: NOW - 500,
                        lastSeen: NOW - 500
                    }
                }
            }
        }
    });

    const harness = createPresenceHarness({
        db,
        now: () => NOW,
        config: { presenceStaleMs: 10000 }
    });

    const snapshot = await harness.presence.getPresenceSnapshot("uid-1");

    assert.equal(snapshot.online, false);
    assert.equal(snapshot.devices[0].online, false);
    assert.equal(snapshot.devices[0].reportedOnline, true);
    assert.equal(snapshot.devices[0].stale, false);
});

test("startup reconciliation marks leftover online entries offline", async () => {
    const db = createFakeDb({
        presence: {
            "uid-1": {
                devices: {
                    "device-1": { status: "online", connectionCount: 1 },
                    "device-2": { status: "offline", connectionCount: 0 }
                }
            },
            "uid-2": {
                devices: {
                    "device-1": { status: "online", connectionCount: 2 }
                }
            }
        }
    });

    const harness = createPresenceHarness({ db });

    const count = await harness.presence.reconcileOnStart();

    assert.equal(count, 2);
    assert.equal(
        db.__data.presence["uid-1"].devices["device-1"].status,
        "offline"
    );
    assert.equal(
        db.__data.presence["uid-1"].devices["device-1"].stale,
        true
    );
    assert.equal(
        db.__data.presence["uid-1"].devices["device-1"].offlineReason,
        "server-restart"
    );
    assert.equal(
        db.__data.presence["uid-2"].devices["device-1"].status,
        "offline"
    );

    const secondRun = await harness.presence.reconcileOnStart();
    assert.equal(secondRun, 0);
});

test("heartbeat updates memory and throttles RTDB writes", async () => {
    const harness = createPresenceHarness({
        config: { presenceHeartbeatWriteMs: 60000 },
        now: () => 500000
    });
    const { socket } = addAndroid(harness.activeSockets, "android-1");

    const first = await harness.presence.handleHeartbeat(socket);
    const second = await harness.presence.handleHeartbeat(socket);

    assert.equal(first.ok, true);
    assert.equal(first.persisted, true);
    assert.equal(second.ok, true);
    assert.equal(second.persisted, false);
    assert.equal(harness.db.__writes.length, 1);

    const record = harness.activeSockets.get("android-1");
    assert.equal(record.lastHeartbeatAt, 500000);
});

test("watchers are removed with their socket and receive no further updates", async () => {
    const harness = createPresenceHarness();

    await harness.presence.watch("web-watcher", "uid-1");
    harness.presence.removeSocket("web-watcher");

    harness.messages.length = 0;

    const { socket } = addAndroid(harness.activeSockets, "android-1");
    await harness.presence.handleAndroidConnect(socket);

    assert.equal(
        harness.messages.filter(
            (entry) => entry.eventName === "presence:update"
        ).length,
        0
    );
});

test("presence responses never expose FCM tokens", async () => {
    const NOW = 1_000_000;
    const db = createFakeDb({
        fcmTokens: {
            "uid-1": {
                "device-1": {
                    token: "super-secret-fcm-token-value-1234567890",
                    updatedAt: NOW
                }
            }
        },
        presence: {
            "uid-1": {
                devices: {
                    "device-1": {
                        status: "online",
                        lastHeartbeatAt: NOW,
                        updatedAt: NOW,
                        lastSeen: NOW
                    }
                }
            }
        }
    });

    const harness = createPresenceHarness({
        db,
        now: () => NOW,
        config: { presenceStaleMs: 10000 }
    });

    const snapshot = await harness.presence.getPresenceSnapshot("uid-1");
    const serialized = JSON.stringify(snapshot);

    assert.equal(serialized.includes("super-secret-fcm-token"), false);
    assert.equal(serialized.includes("token"), false);
});

test("presence writes stay inside the documented presence paths", async () => {
    const harness = createPresenceHarness();
    const { socket, record } = addAndroid(
        harness.activeSockets,
        "android-1"
    );

    await harness.presence.handleAndroidConnect(socket);
    await harness.presence.handleHeartbeat(socket);

    harness.activeSockets.remove("android-1");
    await harness.presence.handleAndroidDisconnect(record);

    for (const write of harness.db.__writes) {
        assert.match(write.path, /^presence(\/|$)/);
    }

    const serialized = JSON.stringify(harness.db.__writes);
    assert.equal(serialized.includes("taskId"), false);
    assert.equal(serialized.includes("eventId"), false);
});
