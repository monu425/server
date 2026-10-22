"use strict";

const UID_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;
const EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CLIENT_TYPES = new Set(["web", "android"]);

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null)
    );
}

function isNonEmptyString(value, maxLength = 4096) {
    return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= maxLength
    );
}

function isValidUid(value) {
    return typeof value === "string" && UID_PATTERN.test(value);
}

function isValidDeviceId(value) {
    return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

function isValidEventType(value, allowedEventTypes) {
    if (typeof value !== "string" || !EVENT_TYPE_PATTERN.test(value)) {
        return false;
    }

    if (!Array.isArray(allowedEventTypes) || allowedEventTypes.length === 0) {
        return true;
    }

    return allowedEventTypes.includes(value);
}

function isValidEventId(value) {
    return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

function isValidFcmToken(value) {
    // FCM tokens are opaque values, not RTDB keys. Accept any reasonable
    // non-whitespace token and avoid rejecting tokens that use newer character
    // sets; the length bound still protects the database and logs.
    return (
        typeof value === "string" &&
        value.length >= 20 &&
        value.length <= 4096 &&
        !/\s/.test(value)
    );
}

function isValidClientType(value) {
    return typeof value === "string" && CLIENT_TYPES.has(value);
}

function byteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch (error) {
        return -1;
    }
}

function validateEventRequest(input, options = {}) {
    const errors = [];

    if (!isPlainObject(input)) {
        return { ok: false, errors: ["request must be a JSON object"] };
    }

    const targetUid = input.targetUid;
    const targetDeviceId = input.targetDeviceId;
    const eventType = input.eventType;
    const payload = input.payload;

    if (!isValidUid(targetUid)) {
        errors.push("targetUid is required and must be a valid Firebase UID");
    }

    if (
        targetDeviceId !== undefined &&
        targetDeviceId !== null &&
        targetDeviceId !== "" &&
        !isValidDeviceId(targetDeviceId)
    ) {
        errors.push("targetDeviceId must be a valid device id when provided");
    }

    if (!isValidEventType(eventType, options.allowedEventTypes)) {
        errors.push(
            "eventType is required, must match [A-Z][A-Z0-9_]{1,63} and be allow-listed"
        );
    }

    if (!isPlainObject(payload)) {
        errors.push("payload is required and must be a plain JSON object");
    } else {
        const size = byteLength(payload);
        const maxBytes = options.payloadMaxBytes ?? 8192;

        if (size < 0) {
            errors.push("payload must be JSON serializable");
        } else if (size > maxBytes) {
            errors.push(`payload exceeds the ${maxBytes} byte limit`);
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        value: {
            targetUid,
            targetDeviceId:
                targetDeviceId === undefined ||
                targetDeviceId === null ||
                targetDeviceId === ""
                    ? null
                    : targetDeviceId,
            eventType,
            payload
        }
    };
}

function validateStatusUpdate(input) {
    if (!isPlainObject(input)) {
        return { ok: false, errors: ["request must be a JSON object"] };
    }

    const errors = [];

    if (!isValidEventId(input.eventId)) {
        errors.push("eventId is required and must be a valid event id");
    }

    if (typeof input.status !== "string" || input.status.length > 32) {
        errors.push("status is required");
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        value: {
            eventId: input.eventId,
            status: input.status,
            message:
                typeof input.message === "string"
                    ? input.message.slice(0, 500)
                    : undefined
        }
    };
}

module.exports = {
    isPlainObject,
    isNonEmptyString,
    isValidUid,
    isValidDeviceId,
    isValidEventType,
    isValidEventId,
    isValidFcmToken,
    isValidClientType,
    byteLength,
    validateEventRequest,
    validateStatusUpdate,
    CLIENT_TYPES
};
