"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { STATUS } = require("../src/utils/statusMachine");
const { ActiveSocketsStore } = require("../src/stores/activeSockets.store");
const {
    testConfig,
    makeEvent,
    createDeliveryHarness
} = require("./helpers/fixtures");
const {
    createFakeDb,
    createFakeMessaging,
    createFakeSocket,
    createNotifier,
    sleep,
    tokenDatabase
} = require("./helpers/fakes");

test("connected Android device receives the event and a timely ACK prevents FCM", async (t) => {
    const harness = createDeliveryHarness();
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    assert.equal(event.status, STATUS.SENT_WS);
    assert.equal(androidSocket.emitted.length, 1);
    assert.equal(androidSocket.emitted[0].eventName, "event:deliver");
    assert.equal(
        androidSocket.emitted[0].payload.payload.taskId,
        "123"
    );

    androidSocket.deliverAck({ status: STATUS.RECEIVED });

    assert.equal(event.status, STATUS.RECEIVED);
    assert.equal(event.ackReceived, true);
    assert.equal(event.timers.ack, null);

    await sleep(testConfig.ackTimeoutMs + 40);

    assert.equal(harness.messaging.callCount, 0);
    assert.ok(harness.notify.statuses().includes(STATUS.RECEIVED));
});

test("absent Socket.IO connection triggers exactly one immediate FCM attempt", async (t) => {
    const harness = createDeliveryHarness();
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: null
    });

    assert.equal(event.status, STATUS.FCM_ATTEMPTED);

    await sleep(40);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(event.status, STATUS.FCM_ACCEPTED);
    assert.equal(event.payload, null, "payload must be released after fallback");

    const message = harness.messaging.sent[0];
    assert.equal(message.token.length > 0, true);
    assert.equal(message.data.eventId, event.eventId);
    assert.equal(message.data.eventType, "TASK_UPDATE");
    assert.equal(JSON.parse(message.data.payload).action, "refresh");
    assert.equal(message.android.ttl, 0);
    assert.equal(message.android.priority, "high");

    const statuses = harness.notify.statuses();
    assert.ok(statuses.includes(STATUS.FCM_ATTEMPTED));
    assert.ok(statuses.includes(STATUS.FCM_ACCEPTED));
    assert.ok(!statuses.includes(STATUS.RECEIVED));
    assert.ok(!statuses.includes(STATUS.COMPLETED));
});

test("a missing ACK triggers only one fallback after the configured timeout", async (t) => {
    const harness = createDeliveryHarness();
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    await sleep(testConfig.ackTimeoutMs + 40);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(event.fallbackAttempted, true);
    assert.equal(event.status, STATUS.FCM_ACCEPTED);

    await sleep(testConfig.ackTimeoutMs + 40);

    assert.equal(harness.messaging.callCount, 1, "no automatic retry");
});

test("disconnect and ACK timeout racing cannot duplicate the FCM send", async (t) => {
    const harness = createDeliveryHarness();
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    const affected = harness.delivery.handleSocketDisconnect("android-socket-1");
    const secondAttempt = harness.delivery.fallbackOnce(
        event.eventId,
        "TEST_RACE"
    );

    assert.equal(affected, 1);
    assert.equal(secondAttempt, false);

    await sleep(testConfig.ackTimeoutMs + 60);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(
        harness.notify
            .statuses()
            .filter((status) => status === STATUS.FCM_ATTEMPTED).length,
        1
    );
});

test("a late ACK after fallback started is recorded without downgrading to FCM_ACCEPTED", async (t) => {
    const pendingSend = [];

    const delayedMessaging = {
        sent: [],
        send(message) {
            this.sent.push(message);
            return new Promise((resolve) => {
                pendingSend.push(() =>
                    resolve(`projects/test/messages/${this.sent.length}`)
                );
            });
        }
    };

    const harness = createDeliveryHarness({
        messaging: delayedMessaging
    });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    harness.delivery.handleSocketDisconnect("android-socket-1");

    // Let token lookup finish and reach the pending messaging.send call.
    await sleep(20);
    assert.equal(delayedMessaging.sent.length, 1);

    harness.delivery.markReceipt(event.eventId, "late-socket-ack");
    assert.equal(event.status, STATUS.RECEIVED);

    pendingSend.forEach((resolve) => resolve());
    await sleep(20);

    assert.equal(delayedMessaging.sent.length, 1);
    assert.equal(event.status, STATUS.RECEIVED);
    assert.ok(!harness.notify.statuses().includes(STATUS.FCM_ACCEPTED));
});

test("a missing FCM token produces DISCARDED and cleans up", async (t) => {
    const harness = createDeliveryHarness({ db: createFakeDb({}) });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: null
    });

    await sleep(40);

    assert.equal(harness.messaging.callCount, 0);
    assert.equal(event.status, STATUS.DISCARDED);

    const discarded = harness.notify.deliveries.at(-1);
    assert.equal(discarded.payload.status, STATUS.DISCARDED);
    assert.equal(discarded.payload.reason, "FCM_TOKEN_MISSING");

    await sleep(testConfig.eventCleanupGraceMs + 30);
    assert.equal(harness.pendingStore.size, 0);
});

test("an FCM send failure produces DISCARDED, sends once and never retries", async (t) => {
    const messaging = createFakeMessaging({ fail: true });
    const harness = createDeliveryHarness({ messaging });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: null
    });

    await sleep(40);

    assert.equal(messaging.callCount, 1);
    assert.equal(event.status, STATUS.DISCARDED);

    const discarded = harness.notify.deliveries.at(-1);
    assert.equal(discarded.payload.reason, "FCM_SEND_FAILED");

    await sleep(testConfig.ackTimeoutMs + 50);
    assert.equal(messaging.callCount, 1);
});

test("app-level PROCESSING after FCM acceptance clears the confirmation timer", async (t) => {
    const harness = createDeliveryHarness({
        config: { postFcmConfirmTimeoutMs: 200, eventCleanupGraceMs: 10 }
    });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: null
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (event.status === STATUS.FCM_ACCEPTED) break;
        await sleep(5);
    }

    assert.equal(event.status, STATUS.FCM_ACCEPTED);

    const processing = harness.delivery.applyAndroidStatus(
        event,
        STATUS.PROCESSING
    );

    assert.equal(processing.ok, true);
    assert.equal(event.timers.fcmConfirm, null);
    assert.equal(event.ackReceived, true);

    await sleep(240);

    assert.equal(event.status, STATUS.PROCESSING);
    assert.ok(!harness.notify.statuses().includes(STATUS.DELIVERY_UNCONFIRMED));
});

test("post-FCM confirmation timeout reports DELIVERY_UNCONFIRMED and cleans up", async (t) => {
    const harness = createDeliveryHarness({
        config: { postFcmConfirmTimeoutMs: 25, eventCleanupGraceMs: 10 }
    });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: null
    });

    await sleep(90);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(event.status, STATUS.DELIVERY_UNCONFIRMED);
    assert.ok(!harness.notify.statuses().includes(STATUS.RECEIVED));

    await sleep(40);
    assert.equal(harness.pendingStore.size, 0);
});

test("status notifications go to the originating socket only and are not replayed", async (t) => {
    const activeSockets = new ActiveSocketsStore();
    const notify = createNotifier({
        isOnline: (socketId) => activeSockets.has(socketId)
    });

    const harness = createDeliveryHarness({ activeSockets, notify });
    t.after(() => harness.delivery.shutdown());

    const webSocket = createFakeSocket("web-socket-1", { clientType: "web" });
    const otherWebSocket = createFakeSocket("web-socket-2", {
        clientType: "web"
    });

    activeSockets.add({
        socketId: "web-socket-1",
        clientType: "web",
        uid: "web-user",
        deviceId: null,
        socket: webSocket,
        connectedAt: 1
    });
    activeSockets.add({
        socketId: "web-socket-2",
        clientType: "web",
        uid: "web-user",
        deviceId: null,
        socket: otherWebSocket,
        connectedAt: 2
    });

    const event = makeEvent({ originSocketId: "web-socket-1" });
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    assert.equal(harness.notify.deliveries.length, 1);
    assert.equal(harness.notify.deliveries[0].socketId, "web-socket-1");

    // Origin disconnects. Later updates must be dropped, not buffered.
    activeSockets.remove("web-socket-1");
    harness.notify.deliveries.length = 0;

    harness.delivery.markReceipt(event.eventId, "android-status");
    harness.delivery.applyAndroidStatus(event, STATUS.PROCESSING);
    harness.delivery.applyAndroidStatus(event, STATUS.COMPLETED);

    assert.equal(harness.notify.deliveries.length, 0);
    assert.equal(
        harness.notify.forSocket("web-socket-2").length,
        0,
        "other sockets claiming the same uid must not receive the status"
    );

    // Simulating a reconnect with a new socket id must not replay old statuses.
    activeSockets.add({
        socketId: "web-socket-3",
        clientType: "web",
        uid: "web-user",
        deviceId: null,
        socket: createFakeSocket("web-socket-3"),
        connectedAt: 3
    });

    assert.equal(harness.notify.forSocket("web-socket-3").length, 0);
});

test("COMPLETED cannot be overwritten by a later PROCESSING update", async (t) => {
    const harness = createDeliveryHarness();
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent({ status: STATUS.SENT_WS });
    harness.pendingStore.create(event);

    harness.delivery.applyAndroidStatus(event, STATUS.RECEIVED);
    harness.delivery.applyAndroidStatus(event, STATUS.PROCESSING);

    const completed = harness.delivery.applyAndroidStatus(
        event,
        STATUS.COMPLETED
    );
    assert.equal(completed.ok, true);
    assert.equal(event.status, STATUS.COMPLETED);

    const late = harness.delivery.applyAndroidStatus(
        event,
        STATUS.PROCESSING
    );
    assert.equal(late.ok, false);
    assert.equal(late.code, "TERMINAL_STATUS");
    assert.equal(event.status, STATUS.COMPLETED);

    assert.equal(event.timers.ack, null);
    assert.equal(event.timers.fcmConfirm, null);
    assert.equal(event.timers.lifetime, null);
});

test("terminal cleanup removes in-memory state and timer handles", async (t) => {
    const harness = createDeliveryHarness({
        config: { eventCleanupGraceMs: 10 }
    });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent({ status: STATUS.SENT_WS });
    harness.pendingStore.create(event);

    harness.delivery.markReceipt(event.eventId, "android-status");
    harness.delivery.applyAndroidStatus(event, STATUS.PROCESSING);
    harness.delivery.applyAndroidStatus(event, STATUS.FAILED);

    assert.equal(event.status, STATUS.FAILED);
    assert.equal(event.timers.ack, null);
    assert.equal(event.timers.fcmConfirm, null);
    assert.equal(event.timers.lifetime, null);
    assert.ok(event.timers.cleanup);

    await sleep(40);

    assert.equal(harness.pendingStore.size, 0);
});

test("hard lifetime safety valve removes records that never become terminal", async (t) => {
    const harness = createDeliveryHarness({
        config: {
            ackTimeoutMs: 5000,
            eventHardTimeoutMs: 40,
            eventCleanupGraceMs: 10
        }
    });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent();
    harness.pendingStore.create(event);

    const androidSocket = createFakeSocket("android-socket-1");
    harness.delivery.startDelivery(event, {
        deviceId: "device-1",
        socket: androidSocket
    });

    assert.equal(harness.pendingStore.size, 1);

    await sleep(80);

    assert.equal(harness.pendingStore.size, 0);
});

test("FCM fallback selects the most recent token device when no device is supplied", async (t) => {
    const db = createFakeDb({
        fcmTokens: {
            "uid-1": {
                "device-old": { token: `${"a".repeat(40)}`, updatedAt: 1000 },
                "device-new": { token: `${"b".repeat(40)}`, updatedAt: 5000 }
            }
        }
    });

    const harness = createDeliveryHarness({ db });
    t.after(() => harness.delivery.shutdown());

    const event = makeEvent({ targetDeviceId: null });
    harness.pendingStore.create(event);

    harness.delivery.startDelivery(event, {
        deviceId: null,
        socket: null
    });

    await sleep(40);

    assert.equal(harness.messaging.callCount, 1);
    assert.equal(event.targetDeviceId, "device-new");
    assert.equal(harness.messaging.sent[0].token, "b".repeat(40));
});

test("token database fixture is available", () => {
    const db = createFakeDb(tokenDatabase("uid-1", "device-1"));
    assert.equal(db.__data.fcmTokens["uid-1"]["device-1"].token.length > 0, true);
});
