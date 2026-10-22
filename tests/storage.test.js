"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEventHarness } = require("./helpers/fixtures");
const {
    createFakeDb,
    createFakeSocket,
    sleep,
    tokenDatabase
} = require("./helpers/fakes");

test("event payloads and event history are never written to RTDB", async (t) => {
    const db = createFakeDb(tokenDatabase("uid-1", "device-1"));
    const harness = createEventHarness({ db });
    t.after(() => harness.delivery.shutdown());

    const webSocket = createFakeSocket("web-socket-1", {
        clientType: "web",
        uid: "web-uid"
    });

    harness.activeSockets.add({
        socketId: "web-socket-1",
        clientType: "web",
        uid: "web-uid",
        deviceId: null,
        socket: webSocket,
        connectedAt: 1
    });

    const androidSocket = createFakeSocket("android-socket-1", {
        clientType: "android",
        uid: "uid-1",
        deviceId: "device-1"
    });

    harness.activeSockets.add({
        socketId: "android-socket-1",
        clientType: "android",
        uid: "uid-1",
        deviceId: "device-1",
        socket: androidSocket,
        connectedAt: 2
    });

    await harness.fcm.registerToken("uid-1", "device-1", "t".repeat(40));

    const response = await new Promise((resolve) => {
        harness.eventService.handleSend(
            webSocket,
            {
                targetUid: "uid-1",
                eventType: "TASK_UPDATE",
                payload: { taskId: "never-persist-me", action: "refresh" }
            },
            resolve
        );
    });

    assert.equal(response.ok, true);

    await sleep(30);

    const serializedWrites = JSON.stringify(db.__writes);

    assert.equal(serializedWrites.includes("never-persist-me"), false);
    assert.equal(serializedWrites.includes("taskId"), false);
    assert.equal(serializedWrites.includes("eventId"), false);
    assert.equal(serializedWrites.includes(response.eventId), false);

    for (const write of db.__writes) {
        assert.match(
            write.path,
            /^(presence|fcmTokens)(\/|$)/,
            `unexpected RTDB path: ${write.path}`
        );
    }

    assert.equal(Object.prototype.hasOwnProperty.call(db.__data, "events"), false);
    assert.equal(
        Object.prototype.hasOwnProperty.call(db.__data, "eventHistory"),
        false
    );
});

test("there is no persistent event queue or retry structure in the stores", async (t) => {
    const harness = createEventHarness({
        db: createFakeDb({})
    });
    t.after(() => harness.delivery.shutdown());

    const webSocket = createFakeSocket("web-socket-1", {
        clientType: "web",
        uid: "web-uid"
    });

    harness.activeSockets.add({
        socketId: "web-socket-1",
        clientType: "web",
        uid: "web-uid",
        deviceId: null,
        socket: webSocket,
        connectedAt: 1
    });

    const response = await new Promise((resolve) => {
        harness.eventService.handleSend(
            webSocket,
            {
                targetUid: "uid-1",
                eventType: "TASK_UPDATE",
                payload: { taskId: "no-queue" }
            },
            resolve
        );
    });

    await sleep(40);

    // Missing token -> DISCARDED, no retry and no queued record.
    await sleep(harness.config.eventCleanupGraceMs + 30);

    assert.equal(harness.pendingStore.size, 0);
    assert.equal(harness.messaging.callCount, 0);
    assert.ok(response.eventId);
});
