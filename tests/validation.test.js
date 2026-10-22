"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    validateEventRequest,
    validateStatusUpdate,
    isValidUid,
    isValidDeviceId,
    isValidEventType,
    isValidFcmToken,
    byteLength
} = require("../src/utils/validators");
const {
    STATUS,
    canTransition,
    isTerminal
} = require("../src/utils/statusMachine");

const options = {
    allowedEventTypes: ["TASK_UPDATE", "NOTIFICATION"],
    payloadMaxBytes: 128
};

test("a valid event request is normalized", () => {
    const result = validateEventRequest(
        {
            targetUid: "receiver-uid",
            eventType: "TASK_UPDATE",
            payload: { taskId: "123", action: "refresh" }
        },
        options
    );

    assert.equal(result.ok, true);
    assert.equal(result.value.targetUid, "receiver-uid");
    assert.equal(result.value.targetDeviceId, null);
    assert.equal(result.value.eventType, "TASK_UPDATE");
    assert.deepEqual(result.value.payload, {
        taskId: "123",
        action: "refresh"
    });
});

test("an optional targetDeviceId is preserved", () => {
    const result = validateEventRequest(
        {
            targetUid: "uid-1",
            targetDeviceId: "android-device-1",
            eventType: "TASK_UPDATE",
            payload: {}
        },
        options
    );

    assert.equal(result.ok, true);
    assert.equal(result.value.targetDeviceId, "android-device-1");
});

test("invalid uid, device id, event type and payloads are rejected", () => {
    const cases = [
        {
            targetUid: "bad/uid",
            eventType: "TASK_UPDATE",
            payload: {}
        },
        {
            targetUid: "uid-1",
            targetDeviceId: "bad/device",
            eventType: "TASK_UPDATE",
            payload: {}
        },
        {
            targetUid: "uid-1",
            eventType: "not-allowed",
            payload: {}
        },
        {
            targetUid: "uid-1",
            eventType: "SOMETHING_ELSE",
            payload: {}
        },
        {
            targetUid: "uid-1",
            eventType: "TASK_UPDATE",
            payload: null
        },
        {
            targetUid: "uid-1",
            eventType: "TASK_UPDATE",
            payload: [1, 2, 3]
        }
    ];

    for (const input of cases) {
        const result = validateEventRequest(input, options);
        assert.equal(result.ok, false);
        assert.ok(result.errors.length > 0);
    }
});

test("oversized payloads are rejected", () => {
    const result = validateEventRequest(
        {
            targetUid: "uid-1",
            eventType: "TASK_UPDATE",
            payload: { data: "x".repeat(200) }
        },
        options
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /byte limit/);
});

test("non-serializable payloads are rejected", () => {
    const payload = {};
    payload.self = payload;

    const result = validateEventRequest(
        {
            targetUid: "uid-1",
            eventType: "TASK_UPDATE",
            payload
        },
        options
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /serializable/);
});

test("status update validation requires a valid event id and status", () => {
    assert.equal(
        validateStatusUpdate({
            eventId: "123e4567-e89b-42d3-a456-426614174000",
            status: "PROCESSING"
        }).ok,
        true
    );

    assert.equal(
        validateStatusUpdate({ eventId: "bad id", status: "PROCESSING" }).ok,
        false
    );

    assert.equal(
        validateStatusUpdate({
            eventId: "123e4567-e89b-42d3-a456-426614174000"
        }).ok,
        false
    );
});

test("uid, device id and token validators enforce safe key characters", () => {
    assert.equal(isValidUid("abc123_-.:@+"), true);
    assert.equal(isValidUid("abc/def"), false);
    assert.equal(isValidUid(""), false);
    assert.equal(isValidDeviceId("device-1"), true);
    assert.equal(isValidDeviceId("device#1"), false);
    assert.equal(isValidEventType("TASK_UPDATE", ["TASK_UPDATE"]), true);
    assert.equal(isValidEventType("TASK_UPDATE", ["OTHER"]), false);
    assert.equal(isValidFcmToken("a".repeat(40)), true);
    assert.equal(isValidFcmToken("short"), false);
});

test("byteLength reports JSON size and circular payloads as -1", () => {
    assert.equal(byteLength({ a: 1 }) > 0, true);

    const circular = {};
    circular.self = circular;
    assert.equal(byteLength(circular), -1);
});

test("the status machine rejects illegal and terminal-to-live transitions", () => {
    assert.equal(canTransition(STATUS.ACCEPTED, STATUS.SENT_WS), true);
    assert.equal(canTransition(STATUS.SENT_WS, STATUS.RECEIVED), true);
    assert.equal(canTransition(STATUS.RECEIVED, STATUS.PROCESSING), true);
    assert.equal(canTransition(STATUS.PROCESSING, STATUS.COMPLETED), true);
    assert.equal(canTransition(STATUS.FCM_ATTEMPTED, STATUS.FCM_ACCEPTED), true);
    assert.equal(canTransition(STATUS.FCM_ACCEPTED, STATUS.RECEIVED), true);
    assert.equal(canTransition(STATUS.COMPLETED, STATUS.PROCESSING), false);
    assert.equal(canTransition(STATUS.FAILED, STATUS.PROCESSING), false);
    assert.equal(canTransition(STATUS.DISCARDED, STATUS.RECEIVED), false);
    assert.equal(
        canTransition(STATUS.DELIVERY_UNCONFIRMED, STATUS.RECEIVED),
        false
    );
    assert.equal(canTransition(STATUS.ACCEPTED, "UNKNOWN"), false);

    assert.equal(isTerminal(STATUS.COMPLETED), true);
    assert.equal(isTerminal(STATUS.FAILED), true);
    assert.equal(isTerminal(STATUS.DISCARDED), true);
    assert.equal(isTerminal(STATUS.DELIVERY_UNCONFIRMED), true);
    assert.equal(isTerminal(STATUS.PROCESSING), false);
});
