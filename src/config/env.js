"use strict";

function readString(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    return value;
}

function readInt(name, fallback, options = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;

    const value = Number(raw);

    if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`${name} must be an integer`);
    }

    const min = options.min ?? Number.MIN_SAFE_INTEGER;
    const max = options.max ?? Number.MAX_SAFE_INTEGER;

    if (value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}`);
    }

    return value;
}

function readBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;

    const normalized = raw.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;

    throw new Error(`${name} must be a boolean`);
}

function readList(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;

    return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseCorsOrigins(raw) {
    const list = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    if (list.length === 0 || list.includes("*")) {
        return "*";
    }

    return list;
}

function loadEnv() {
    const nodeEnv = readString("NODE_ENV", "development");

    const allowedEventTypes = readList("ALLOWED_EVENT_TYPES", [
        "TASK_UPDATE",
        "NOTIFICATION",
        "WAKEUP",
        "SYNC"
    ]);

    if (allowedEventTypes.length === 0) {
        throw new Error("ALLOWED_EVENT_TYPES must contain at least one value");
    }

    for (const eventType of allowedEventTypes) {
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(eventType)) {
            throw new Error(
                `ALLOWED_EVENT_TYPES contains an invalid event type: ${eventType}`
            );
        }
    }

    const databaseUrl = readString("FIREBASE_DATABASE_URL", "");

    if (!databaseUrl) {
        throw new Error("FIREBASE_DATABASE_URL is required");
    }

    if (!/^https:\/\/.+/.test(databaseUrl)) {
        throw new Error("FIREBASE_DATABASE_URL must be an https URL");
    }

    const rawCors = readString("CORS_ORIGINS", "*");

    const config = {
        nodeEnv,
        isProduction: nodeEnv === "production",
        port: readInt("PORT", 3000, { min: 1, max: 65535 }),
        logLevel: readString("LOG_LEVEL", "info"),
        corsOrigins: parseCorsOrigins(rawCors),

        firebaseDatabaseUrl: databaseUrl,
        firebaseProjectId: readString("FIREBASE_PROJECT_ID", null),
        firebaseClientEmail: readString("FIREBASE_CLIENT_EMAIL", null),
        firebasePrivateKey: readString("FIREBASE_PRIVATE_KEY", null),
        firebaseServiceAccountJson: readString(
            "FIREBASE_SERVICE_ACCOUNT_JSON",
            null
        ),
        firebaseServiceAccountPath: readString(
            "FIREBASE_SERVICE_ACCOUNT_PATH",
            null
        ),

        ackTimeoutMs: readInt("ACK_TIMEOUT_MS", 12000, {
            min: 500,
            max: 120000
        }),
        postFcmConfirmTimeoutMs: readInt(
            "POST_FCM_CONFIRM_TIMEOUT_MS",
            60000,
            { min: 1000, max: 600000 }
        ),
        eventCleanupGraceMs: readInt("EVENT_CLEANUP_GRACE_MS", 5000, {
            min: 0,
            max: 600000
        }),
        eventHardTimeoutMs: readInt("EVENT_HARD_TIMEOUT_MS", 300000, {
            min: 10000,
            max: 3600000
        }),
        eventPayloadMaxBytes: readInt("EVENT_PAYLOAD_MAX_BYTES", 4096, {
            min: 256,
            max: 1048576
        }),
        allowedEventTypes,
        maxInFlightEvents: readInt("MAX_IN_FLIGHT_EVENTS", 10000, {
            min: 100,
            max: 1000000
        }),

        presenceStaleMs: readInt("PRESENCE_STALE_MS", 120000, {
            min: 5000,
            max: 3600000
        }),
        presenceHeartbeatWriteMs: readInt(
            "PRESENCE_HEARTBEAT_WRITE_MS",
            30000,
            { min: 1000, max: 3600000 }
        ),
        reconcilePresenceOnStart: readBool(
            "RECONCILE_PRESENCE_ON_START",
            true
        ),

        socketPingIntervalMs: readInt("SOCKET_PING_INTERVAL_MS", 25000, {
            min: 5000,
            max: 120000
        }),
        socketPingTimeoutMs: readInt("SOCKET_PING_TIMEOUT_MS", 60000, {
            min: 5000,
            max: 300000
        }),
        socketMaxHttpBufferBytes: readInt(
            "SOCKET_MAX_HTTP_BUFFER_BYTES",
            1048576,
            { min: 65536, max: 10485760 }
        ),

        rateLimits: {
            eventSend: readInt("RATE_LIMIT_EVENT_SEND", 30, {
                min: 1,
                max: 10000
            }),
            eventStatus: readInt("RATE_LIMIT_EVENT_STATUS", 120, {
                min: 1,
                max: 100000
            }),
            fcmRegister: readInt("RATE_LIMIT_FCM_REGISTER", 10, {
                min: 1,
                max: 10000
            }),
            presence: readInt("RATE_LIMIT_PRESENCE", 30, {
                min: 1,
                max: 10000
            }),
            heartbeat: readInt("RATE_LIMIT_HEARTBEAT", 12, {
                min: 1,
                max: 10000
            }),
            windowMs: readInt("RATE_LIMIT_WINDOW_MS", 60000, {
                min: 1000,
                max: 3600000
            })
        }
    };

    return Object.freeze(config);
}

module.exports = { loadEnv };
