"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { PendingEventsStore } = require("../src/stores/pendingEvents.store");
const { createSocketRateLimiter } = require("../src/utils/rateLimiter");
const { STATUS } = require("../src/utils/statusMachine");
const {
    testConfig,
    createEventHarness
} = require("./helpers/fixtures");
const {
    createFakeDb,
    createFakeSocket,
    sleep
} = require("./helpers/fakes");

function addWebSocket(activeSockets, id = "web-socket-1", uid = "web-uid") {
    const socket = createFakeSocket(id, { clientType: "web", uid });

    activeSockets.add({
        socketId: id,
        clientType: "web",
        uid,
        deviceId: null,
        socket,
        connectedAt: Date.now()
    });

    return socket;
}

function addAndroidSocket(
    activeSockets,
    id = "android-socket-1",
    uid = "uid-1",
    deviceId = "device-1",
    connectedAt = Date.now()
) {
    const socket = createFakeSocket(id, {
        clientType: "android",
        uid,
        deviceId
    });

    activeSockets.add({
        socketId: id,
        clientType: "android",
        uid,
        deviceId,
        socket,
        connectedAt
    });

    return socket;
}

function sendEvent(eventService, socket, request) {
    return new Promise((resolve) => {
        eventService.handleSend(socket, request, resolve);
    });
}

function sendStatus(eventService, socket, update) {
    return new Promise((resolve) => {
        eventService.handleAndroidStatus(socket, update, resolve);
    });
}

test("event:send ACK is distinct from later Android status notifications", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const androidSocket = addAndroidSocket(harness.activeSockets);

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "123", action: "refresh" }
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, STATUS.ACCEPTED);
    assert.equal(typeof response.eventId, "string");
    assert.ok(response.acceptedAt > 0);
    assert.equal(response.eventId.length, 36);

    await sleep(20);

    const event = harness.pendingStore.get(response.eventId);
    assert.ok(event);
    assert.equal(event.status, STATUS.SENT_WS);
    assert.equal(androidSocket.emitted.length, 1);
    assert.equal(androidSocket.emitted[0].eventName, "event:deliver");

    androidSocket.deliverAck({ status: STATUS.RECEIVED });

    const processing = await sendStatus(harness.eventService, androidSocket, {
        eventId: response.eventId,
        status: STATUS.PROCESSING
    });
    assert.equal(processing.ok, true);

    const completed = await sendStatus(harness.eventService, androidSocket, {
        eventId: response.eventId,
        status: STATUS.COMPLETED
    });
    assert.equal(completed.ok, true);

    const statuses = harness.notify.forSocket("web-socket-1");
    const sequence = statuses.map((entry) => entry.payload.status);

    assert.deepEqual(sequence, [
        STATUS.ACCEPTED,
        STATUS.SENT_WS,
        STATUS.RECEIVED,
        STATUS.PROCESSING,
        STATUS.COMPLETED
    ]);

    assert.ok(statuses.every((entry) => entry.socketId === "web-socket-1"));
    assert.equal(harness.pendingStore.get(response.eventId).status, STATUS.COMPLETED);
});

test("an explicit targetDeviceId is used exclusively", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const firstAndroid = addAndroidSocket(
        harness.activeSockets,
        "android-socket-1",
        "uid-1",
        "device-1",
        1
    );
    const secondAndroid = addAndroidSocket(
        harness.activeSockets,
        "android-socket-2",
        "uid-1",
        "device-2",
        2
    );

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        targetDeviceId: "device-2",
        eventType: "TASK_UPDATE",
        payload: { taskId: "explicit" }
    });

    assert.equal(response.ok, true);
    await sleep(20);

    assert.equal(firstAndroid.emitted.length, 0);
    assert.equal(secondAndroid.emitted.length, 1);
    assert.equal(
        secondAndroid.emitted[0].payload.targetDeviceId,
        "device-2"
    );
});

test("omitted device id deterministically chooses one active device", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const deviceTwo = addAndroidSocket(
        harness.activeSockets,
        "android-socket-2",
        "uid-1",
        "device-2",
        10
    );
    const deviceOne = addAndroidSocket(
        harness.activeSockets,
        "android-socket-1",
        "uid-1",
        "device-1",
        20
    );

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "deterministic" }
    });

    assert.equal(response.ok, true);
    await sleep(20);

    assert.equal(deviceOne.emitted.length, 1);
    assert.equal(deviceTwo.emitted.length, 0);
});

test("with no active socket the most recently registered token device is used", async (t) => {
    const db = createFakeDb({
        fcmTokens: {
            "uid-1": {
                "device-old": { token: "a".repeat(40), updatedAt: 1000 },
                "device-new": { token: "b".repeat(40), updatedAt: 9000 }
            }
        }
    });

    const harness = createEventHarness({ db });
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "token-device" }
    });

    assert.equal(response.ok, true);
    await sleep(40);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(harness.messaging.sent[0].token, "b".repeat(40));
    assert.equal(
        harness.messaging.sent[0].data.targetDeviceId,
        "device-new"
    );
});

test("invalid event requests are rejected before delivery starts", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const androidSocket = addAndroidSocket(harness.activeSockets);

    const cases = [
        {
            name: "missing uid",
            request: {
                eventType: "TASK_UPDATE",
                payload: { taskId: "1" }
            },
            code: "INVALID_EVENT"
        },
        {
            name: "bad event type",
            request: {
                targetUid: "uid-1",
                eventType: "task-update",
                payload: { taskId: "1" }
            },
            code: "INVALID_EVENT"
        },
        {
            name: "payload not object",
            request: {
                targetUid: "uid-1",
                eventType: "TASK_UPDATE",
                payload: ["nope"]
            },
            code: "INVALID_EVENT"
        },
        {
            name: "oversized payload",
            request: {
                targetUid: "uid-1",
                eventType: "TASK_UPDATE",
                payload: { data: "x".repeat(400) }
            },
            code: "INVALID_EVENT"
        },
        {
            name: "not an object",
            request: "hello",
            code: "INVALID_EVENT"
        }
    ];

    for (const testCase of cases) {
        const response = await sendEvent(
            harness.eventService,
            webSocket,
            testCase.request
        );

        assert.equal(response.ok, false, testCase.name);
        assert.equal(response.error.code, testCase.code, testCase.name);
    }

    assert.equal(harness.pendingStore.size, 0);
    assert.equal(androidSocket.emitted.length, 0);
    assert.equal(harness.messaging.callCount, 0);
});

test("an Android socket cannot report status for another device's event", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const targetAndroid = addAndroidSocket(
        harness.activeSockets,
        "android-socket-1",
        "uid-1",
        "device-1"
    );
    const otherAndroid = addAndroidSocket(
        harness.activeSockets,
        "android-socket-2",
        "uid-1",
        "device-2"
    );

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        targetDeviceId: "device-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "guard" }
    });

    await sleep(20);

    const rejected = await sendStatus(
        harness.eventService,
        otherAndroid,
        {
            eventId: response.eventId,
            status: STATUS.RECEIVED
        }
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "EVENT_NOT_FOR_THIS_DEVICE");

    const accepted = await sendStatus(
        harness.eventService,
        targetAndroid,
        {
            eventId: response.eventId,
            status: STATUS.RECEIVED
        }
    );

    assert.equal(accepted.ok, true);
    assert.equal(
        harness.pendingStore.get(response.eventId).ackReceived,
        true
    );
});

test("web clients cannot report Android status updates", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    addAndroidSocket(harness.activeSockets);

    const response = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "web-status" }
    });

    const rejected = await sendStatus(harness.eventService, webSocket, {
        eventId: response.eventId,
        status: STATUS.RECEIVED
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "FORBIDDEN_CLIENT_TYPE");
});

test("unknown event ids are rejected", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    addWebSocket(harness.activeSockets);
    const androidSocket = addAndroidSocket(harness.activeSockets);

    const response = await sendStatus(harness.eventService, androidSocket, {
        eventId: "00000000-0000-4000-8000-000000000000",
        status: STATUS.RECEIVED
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, "UNKNOWN_EVENT");
});

test("rate limiting rejects excess event:send calls", async (t) => {
    const rateLimiter = createSocketRateLimiter({
        windowMs: testConfig.rateLimits.windowMs,
        limits: { eventSend: 1 }
    });

    const harness = createEventHarness({ rateLimiter });
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    addAndroidSocket(harness.activeSockets);

    const first = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "one" }
    });
    const second = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "two" }
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "RATE_LIMITED");
});

test("in-flight capacity rejects new events instead of growing unbounded", async (t) => {
    const pendingStore = new PendingEventsStore({ maxEvents: 1 });
    const harness = createEventHarness({ pendingStore });
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    addAndroidSocket(harness.activeSockets);

    const first = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "one" }
    });
    const second = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "two" }
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "SERVER_BUSY");
});

test("event ids are server generated UUIDs and never derived from client input", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    addAndroidSocket(harness.activeSockets);

    const first = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "one" }
    });
    const second = await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "two" }
    });

    assert.notEqual(first.eventId, second.eventId);
    assert.match(
        first.eventId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
});

test("deliver payload event name is fixed and event type stays inside the payload", async (t) => {
    const harness = createEventHarness();
    t.after(() => harness.delivery.shutdown());

    const webSocket = addWebSocket(harness.activeSockets);
    const androidSocket = addAndroidSocket(harness.activeSockets);

    await sendEvent(harness.eventService, webSocket, {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "fixed-name" }
    });

    await sleep(20);

    assert.equal(androidSocket.emitted.length, 1);
    assert.equal(androidSocket.emitted[0].eventName, "event:deliver");
    assert.equal(androidSocket.emitted[0].payload.eventType, "TASK_UPDATE");
    assert.equal(
        androidSocket.emitted[0].eventName.includes("TASK_UPDATE"),
        false
    );
});
