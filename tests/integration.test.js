"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");

const { startTestServer } = require("./helpers/testServer");
const {
    TEST_TOKEN,
    createFakeDb,
    sleep,
    tokenDatabase
} = require("./helpers/fakes");

function connectClient(url, auth) {
    return new Promise((resolve, reject) => {
        const socket = io(url, {
            auth,
            transports: ["websocket"],
            reconnection: false,
            timeout: 4000
        });

        const timer = setTimeout(() => {
            socket.close();
            reject(new Error("Socket connection timeout"));
        }, 4000);

        socket.once("connection:ready", () => {
            clearTimeout(timer);
            resolve(socket);
        });

        socket.once("connection:error", (error) => {
            clearTimeout(timer);
            socket.close();
            reject(new Error(`Connection rejected: ${error.code}`));
        });

        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            socket.close();
            reject(error);
        });
    });
}

function emitAck(socket, eventName, payload, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${eventName} ACK timeout`)),
            timeoutMs
        );

        socket.emit(eventName, payload, (response) => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

async function waitFor(predicate, options = {}) {
    const timeout = options.timeout ?? 4000;
    const interval = options.interval ?? 20;
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const value = predicate();

        if (value) return value;

        await sleep(interval);
    }

    throw new Error("Timed out waiting for condition");
}

test("end-to-end: web sends, Android receives over Socket.IO, acknowledges and completes", async (t) => {
    const server = await startTestServer();
    const clients = [];

    t.after(async () => {
        for (const client of clients) {
            client.close();
        }

        await server.close();
    });

    const web = await connectClient(server.url, {
        clientType: "web",
        uid: "web-uid"
    });
    const android = await connectClient(server.url, {
        clientType: "android",
        uid: "uid-1",
        deviceId: "device-1"
    });

    clients.push(web, android);

    const registered = await emitAck(android, "android:register-fcm", {
        token: TEST_TOKEN
    });
    assert.equal(registered.ok, true);
    assert.equal(
        server.db.__data.fcmTokens["uid-1"]["device-1"].token,
        TEST_TOKEN
    );

    const webStatuses = [];
    const androidStatuses = [];
    const received = [];

    web.on("event:status", (status) => webStatuses.push(status));
    android.on("event:status", (status) => androidStatuses.push(status));

    android.on("event:deliver", (data, ack) => {
        received.push(data);

        if (typeof ack === "function") {
            ack({ status: "RECEIVED" });
        }

        setTimeout(() => {
            android.emit("event:status", {
                eventId: data.eventId,
                status: "PROCESSING"
            });
        }, 10);

        setTimeout(() => {
            android.emit("event:status", {
                eventId: data.eventId,
                status: "COMPLETED"
            });
        }, 25);
    });

    const ack = await emitAck(web, "event:send", {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "e2e-1", action: "refresh" }
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.status, "ACCEPTED");

    await waitFor(() =>
        webStatuses.some((status) => status.status === "COMPLETED")
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].eventId, ack.eventId);
    assert.equal(received[0].payload.taskId, "e2e-1");
    assert.equal(received[0].eventType, "TASK_UPDATE");

    const sequence = webStatuses
        .filter((status) => status.eventId === ack.eventId)
        .map((status) => status.status);

    for (const expected of [
        "ACCEPTED",
        "SENT_WS",
        "RECEIVED",
        "PROCESSING",
        "COMPLETED"
    ]) {
        assert.ok(sequence.includes(expected), `missing ${expected}`);
    }

    assert.ok(sequence.indexOf("SENT_WS") < sequence.indexOf("RECEIVED"));
    assert.ok(sequence.indexOf("RECEIVED") < sequence.indexOf("PROCESSING"));
    assert.ok(sequence.indexOf("PROCESSING") < sequence.indexOf("COMPLETED"));
    assert.equal(androidStatuses.length, 0);
    assert.equal(server.messaging.callCount, 0);
});

test("end-to-end: no Android connection causes one FCM attempt and no false RECEIVED", async (t) => {
    const server = await startTestServer({
        db: createFakeDb(tokenDatabase("uid-1", "device-1"))
    });
    const clients = [];

    t.after(async () => {
        clients.forEach((client) => client.close());
        await server.close();
    });

    const web = await connectClient(server.url, {
        clientType: "web",
        uid: "web-uid"
    });
    clients.push(web);

    const statuses = [];
    web.on("event:status", (status) => statuses.push(status));

    const ack = await emitAck(web, "event:send", {
        targetUid: "uid-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "fcm-1" }
    });

    assert.equal(ack.ok, true);

    await waitFor(() =>
        statuses.some((status) => status.status === "FCM_ACCEPTED")
    );

    const sequence = statuses
        .filter((status) => status.eventId === ack.eventId)
        .map((status) => status.status);

    assert.ok(sequence.includes("FCM_ATTEMPTED"));
    assert.ok(sequence.includes("FCM_ACCEPTED"));
    assert.ok(!sequence.includes("RECEIVED"));
    assert.ok(!sequence.includes("COMPLETED"));
    assert.equal(server.messaging.callCount, 1);
    assert.equal(
        JSON.parse(server.messaging.sent[0].data.payload).taskId,
        "fcm-1"
    );
});

test("end-to-end: presence watch reports online and then offline", async (t) => {
    const server = await startTestServer();
    const clients = [];

    t.after(async () => {
        for (const client of clients) {
            client.close();
        }

        await server.close();
    });

    const web = await connectClient(server.url, {
        clientType: "web",
        uid: "web-uid"
    });
    const android = await connectClient(server.url, {
        clientType: "android",
        uid: "uid-1",
        deviceId: "device-1"
    });

    clients.push(web);

    const updates = [];
    web.on("presence:update", (update) => updates.push(update));

    const initial = await emitAck(web, "presence:watch", { uid: "uid-1" });

    assert.equal(initial.ok, true);
    assert.equal(initial.online, true);
    assert.equal(initial.devices[0].deviceId, "device-1");

    android.close();

    await waitFor(() =>
        updates.some(
            (update) => update.deviceId === "device-1" && update.online === false
        )
    );

    const offline = updates.find(
        (update) => update.deviceId === "device-1" && update.online === false
    );
    assert.ok(offline);
});
