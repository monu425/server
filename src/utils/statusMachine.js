"use strict";

const STATUS = Object.freeze({
    ACCEPTED: "ACCEPTED",
    SENT_WS: "SENT_WS",
    RECEIVED: "RECEIVED",
    PROCESSING: "PROCESSING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    FCM_ATTEMPTED: "FCM_ATTEMPTED",
    FCM_ACCEPTED: "FCM_ACCEPTED",
    DISCARDED: "DISCARDED",
    DELIVERY_UNCONFIRMED: "DELIVERY_UNCONFIRMED"
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

const ANDROID_STATUSES = Object.freeze([
    STATUS.RECEIVED,
    STATUS.PROCESSING,
    STATUS.COMPLETED,
    STATUS.FAILED
]);

const TERMINAL_STATUSES = Object.freeze(
    new Set([
        STATUS.COMPLETED,
        STATUS.FAILED,
        STATUS.DISCARDED,
        STATUS.DELIVERY_UNCONFIRMED
    ])
);

// Explicit allow-list of status transitions. There is intentionally no path
// from a terminal status (for example COMPLETED) back to PROCESSING.
const TRANSITIONS = Object.freeze({
    [STATUS.ACCEPTED]: new Set([
        STATUS.SENT_WS,
        STATUS.RECEIVED,
        STATUS.FCM_ATTEMPTED,
        STATUS.DISCARDED
    ]),
    [STATUS.SENT_WS]: new Set([
        STATUS.RECEIVED,
        STATUS.FCM_ATTEMPTED,
        STATUS.DISCARDED
    ]),
    [STATUS.RECEIVED]: new Set([
        STATUS.PROCESSING,
        STATUS.COMPLETED,
        STATUS.FAILED
    ]),
    [STATUS.PROCESSING]: new Set([STATUS.COMPLETED, STATUS.FAILED]),
    [STATUS.FCM_ATTEMPTED]: new Set([
        STATUS.FCM_ACCEPTED,
        STATUS.RECEIVED,
        STATUS.DISCARDED
    ]),
    [STATUS.FCM_ACCEPTED]: new Set([
        STATUS.RECEIVED,
        STATUS.PROCESSING,
        STATUS.COMPLETED,
        STATUS.FAILED,
        STATUS.DELIVERY_UNCONFIRMED
    ]),
    [STATUS.COMPLETED]: new Set(),
    [STATUS.FAILED]: new Set(),
    [STATUS.DISCARDED]: new Set(),
    [STATUS.DELIVERY_UNCONFIRMED]: new Set()
});

function canTransition(from, to) {
    if (!ALL_STATUSES.includes(to)) return false;
    if (from === to) return false;
    const allowed = TRANSITIONS[from];
    return Boolean(allowed && allowed.has(to));
}

function isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
}

module.exports = {
    STATUS,
    ALL_STATUSES,
    ANDROID_STATUSES,
    TERMINAL_STATUSES,
    TRANSITIONS,
    canTransition,
    isTerminal
};
