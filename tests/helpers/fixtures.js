"use strict";

const { randomUUID } = require("node:crypto");
const { PendingEventsStore } = require("../../src/stores/pendingEvents.store");
const { ActiveSocketsStore } = require("../../src/stores/activeSockets.store");
const {
    createDeliveryService
} = require("../../src/services/delivery.service");
const { createEventService } = require("../../src/services/event.service");
const { createSocketRateLimiter } = require("../../src/utils/rateLimiter");
const { STATUS } = require("../../src/utils/statusMachine");
const {
    silentLogger,
    createFakeDb,
    createTestFcm,
    createNotifier,
    tokenDatabase
} = require("./fakes");

const testConfig = Object.freeze({
    ackTimeoutMs: 30,
    postFcmConfirmTimeoutMs: 40,
    eventCleanupGraceMs: 15,
    eventHardTimeoutMs: 2000,
    allowedEventTypes: ["TASK_UPDATE", "NOTIFICATION"],
    eventPayloadMaxBytes: 256,
    maxInFlightEvents: 100,
    presenceStaleMs: 120000,
    presenceHeartbeatWriteMs: 1000,
    rateLimits: {
        windowMs: 60000,
        eventSend: 1000,
        eventStatus: 1000,
        fcmRegister: 1000,
        presence: 1000,
        heartbeat: 1000
    }
});

function createRateLimiter(config = testConfig) {
    return createSocketRateLimiter({
        windowMs: config.rateLimits.windowMs,
        limits: {
            eventSend: config.rateLimits.eventSend,
            eventStatus: config.rateLimits.eventStatus,
            fcmRegister: config.rateLimits.fcmRegister,
            presence: config.rateLimits.presence,
            heartbeat: config.rateLimits.heartbeat
        }
    });
}

function makeEvent(overrides = {}) {
    return {
        eventId: randomUUID(),
        originSocketId: "web-socket-1",
        targetUid: "uid-1",
        targetDeviceId: "device-1",
        eventType: "TASK_UPDATE",
        payload: { taskId: "123", action: "refresh" },
        status: STATUS.ACCEPTED,
        ackReceived: false,
        fallbackAttempted: false,
        targetSocketId: null,
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        timers: {
            ack: null,
            fcmConfirm: null,
            cleanup: null,
            lifetime: null
        },
        ...overrides
    };
}

function createDeliveryHarness(options = {}) {
    const db = options.db || createFakeDb(tokenDatabase("uid-1", "device-1"));
    const { service: fcm, messaging } = createTestFcm({
        db,
        messaging: options.messaging
    });
    const pendingStore = options.pendingStore || new PendingEventsStore();
    const activeSockets =
        options.activeSockets || new ActiveSocketsStore();
    const notify = options.notify || createNotifier();

    const config = { ...testConfig, ...(options.config || {}) };

    const delivery = createDeliveryService({
        pendingStore,
        activeSockets,
        fcm,
        notify,
        config,
        logger: silentLogger
    });

    return {
        db,
        fcm,
        messaging,
        pendingStore,
        activeSockets,
        notify,
        config,
        delivery
    };
}

function createEventHarness(options = {}) {
    const harness = createDeliveryHarness(options);
    const rateLimiter = options.rateLimiter || createRateLimiter(harness.config);

    const eventService = createEventService({
        pendingStore: harness.pendingStore,
        activeSockets: harness.activeSockets,
        delivery: harness.delivery,
        fcm: harness.fcm,
        rateLimiter,
        config: harness.config,
        logger: silentLogger
    });

    return { ...harness, rateLimiter, eventService };
}

module.exports = {
    testConfig,
    createRateLimiter,
    makeEvent,
    createDeliveryHarness,
    createEventHarness
};
