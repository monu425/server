"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnv } = require("../src/config/env");
const { redact } = require("../src/utils/logger");

function withEnv(values, run) {
    const snapshot = { ...process.env };

    for (const key of Object.keys(values)) {
        if (values[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = values[key];
        }
    }

    try {
        return run();
    } finally {
        for (const key of Object.keys(process.env)) {
            if (!(key in snapshot)) delete process.env[key];
        }

        for (const [key, value] of Object.entries(snapshot)) {
            process.env[key] = value;
        }
    }
}

test("loadEnv fails fast when FIREBASE_DATABASE_URL is missing", () => {
    assert.throws(
        () =>
            withEnv(
                {
                    FIREBASE_DATABASE_URL: undefined
                },
                () => loadEnv()
            ),
        /FIREBASE_DATABASE_URL is required/
    );
});

test("loadEnv rejects invalid numeric and list values", () => {
    assert.throws(
        () =>
            withEnv(
                {
                    FIREBASE_DATABASE_URL:
                        "https://example-default-rtdb.firebaseio.com",
                    ACK_TIMEOUT_MS: "not-a-number"
                },
                () => loadEnv()
            ),
        /ACK_TIMEOUT_MS must be an integer/
    );

    assert.throws(
        () =>
            withEnv(
                {
                    FIREBASE_DATABASE_URL:
                        "https://example-default-rtdb.firebaseio.com",
                    ALLOWED_EVENT_TYPES: "bad-event"
                },
                () => loadEnv()
            ),
        /invalid event type/
    );
});

test("loadEnv parses a valid configuration", () => {
    const config = withEnv(
        {
            NODE_ENV: "test",
            PORT: "4321",
            CORS_ORIGINS: "https://a.example,https://b.example",
            FIREBASE_DATABASE_URL:
                "https://example-default-rtdb.firebaseio.com",
            ACK_TIMEOUT_MS: "15000",
            POST_FCM_CONFIRM_TIMEOUT_MS: "60000",
            ALLOWED_EVENT_TYPES: "TASK_UPDATE,SYNC",
            RECONCILE_PRESENCE_ON_START: "false"
        },
        () => loadEnv()
    );

    assert.equal(config.port, 4321);
    assert.equal(config.ackTimeoutMs, 15000);
    assert.deepEqual(config.corsOrigins, [
        "https://a.example",
        "https://b.example"
    ]);
    assert.deepEqual(config.allowedEventTypes, ["TASK_UPDATE", "SYNC"]);
    assert.equal(config.reconcilePresenceOnStart, false);
    assert.equal(Object.isFrozen(config), true);
});

test("logger redaction hides tokens, payloads, credentials and private keys", () => {
    const redacted = redact({
        token: "secret-token",
        fcmToken: "secret-fcm-token",
        payload: { taskId: "123" },
        authorization: "Bearer abc",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        nested: {
            password: "hunter2",
            ok: "visible"
        },
        safeId: "event-1"
    });

    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.fcmToken, "[REDACTED]");
    assert.equal(redacted.payload, "[REDACTED]");
    assert.equal(redacted.authorization, "[REDACTED]");
    assert.equal(redacted.privateKey, "[REDACTED]");
    assert.equal(redacted.nested.password, "[REDACTED]");
    assert.equal(redacted.nested.ok, "visible");
    assert.equal(redacted.safeId, "event-1");
});
