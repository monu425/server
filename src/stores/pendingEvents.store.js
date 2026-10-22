"use strict";

function createEmptyTimers() {
    return {
        ack: null,
        fcmConfirm: null,
        cleanup: null,
        lifetime: null
    };
}

/**
 * In-memory, single-process store for events that are currently being handled.
 * Nothing in this store is ever persisted.
 */
class PendingEventsStore {
    constructor(options = {}) {
        this.events = new Map();
        this.maxEvents = options.maxEvents ?? 10000;
    }

    isFull() {
        return this.events.size >= this.maxEvents;
    }

    create(metadata) {
        if (!metadata || typeof metadata.eventId !== "string") {
            throw new Error("eventId is required");
        }

        if (this.events.has(metadata.eventId)) {
            throw new Error("duplicate eventId");
        }

        // Keep the exact object so callers and the store share one record.
        // This also guarantees timer handles and status are never duplicated.
        if (!metadata.timers) {
            metadata.timers = createEmptyTimers();
        }

        this.events.set(metadata.eventId, metadata);
        return metadata;
    }

    get(eventId) {
        return this.events.get(eventId) || null;
    }

    has(eventId) {
        return this.events.has(eventId);
    }

    delete(eventId) {
        const record = this.events.get(eventId);

        if (!record) return false;

        this.clearTimers(record);
        this.events.delete(eventId);
        return true;
    }

    clearTimers(record) {
        if (!record || !record.timers) return;

        for (const name of Object.keys(record.timers)) {
            const handle = record.timers[name];

            if (handle) {
                clearTimeout(handle);
                record.timers[name] = null;
            }
        }
    }

    values() {
        return this.events.values();
    }

    entries() {
        return this.events.entries();
    }

    get size() {
        return this.events.size;
    }

    clearAll() {
        for (const record of this.events.values()) {
            this.clearTimers(record);
        }

        this.events.clear();
    }
}

module.exports = { PendingEventsStore, createEmptyTimers };
