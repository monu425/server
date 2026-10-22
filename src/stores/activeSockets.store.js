"use strict";

class ActiveSocketsStore {
    constructor() {
        // socketId -> socket record
        this.socketsById = new Map();
        // `${uid}\u0000${deviceId}` -> Set<socketId> (Android sockets only)
        this.deviceSockets = new Map();
    }

    static deviceKey(uid, deviceId) {
        return `${uid}\u0000${deviceId}`;
    }

    add(record) {
        if (!record || typeof record.socketId !== "string") {
            throw new Error("socketId is required");
        }

        this.socketsById.set(record.socketId, record);

        if (record.clientType === "android") {
            const key = ActiveSocketsStore.deviceKey(
                record.uid,
                record.deviceId
            );

            let set = this.deviceSockets.get(key);

            if (!set) {
                set = new Set();
                this.deviceSockets.set(key, set);
            }

            set.add(record.socketId);
        }

        return record;
    }

    get(socketId) {
        return this.socketsById.get(socketId) || null;
    }

    has(socketId) {
        return this.socketsById.has(socketId);
    }

    remove(socketId) {
        const record = this.socketsById.get(socketId);

        if (!record) return null;

        this.socketsById.delete(socketId);

        if (record.clientType === "android") {
            const key = ActiveSocketsStore.deviceKey(
                record.uid,
                record.deviceId
            );
            const set = this.deviceSockets.get(key);

            if (set) {
                set.delete(socketId);

                if (set.size === 0) {
                    this.deviceSockets.delete(key);
                }
            }
        }

        return record;
    }

    getDeviceSockets(uid, deviceId) {
        const set = this.deviceSockets.get(
            ActiveSocketsStore.deviceKey(uid, deviceId)
        );

        if (!set) return [];

        return [...set]
            .map((socketId) => this.socketsById.get(socketId))
            .filter(Boolean);
    }

    countDeviceSockets(uid, deviceId) {
        const set = this.deviceSockets.get(
            ActiveSocketsStore.deviceKey(uid, deviceId)
        );

        return set ? set.size : 0;
    }

    getActiveDeviceIds(uid) {
        const deviceIds = [];

        for (const [key, set] of this.deviceSockets.entries()) {
            if (set.size === 0) continue;
            const separator = key.indexOf("\u0000");
            const keyUid = key.slice(0, separator);
            const deviceId = key.slice(separator + 1);

            if (keyUid === uid) {
                deviceIds.push(deviceId);
            }
        }

        return deviceIds.sort();
    }

    isUserOnline(uid) {
        return this.getActiveDeviceIds(uid).length > 0;
    }

    getUserSockets(uid) {
        return [...this.socketsById.values()].filter(
            (record) => record.uid === uid
        );
    }

    isDeviceOnline(uid, deviceId) {
        return this.countDeviceSockets(uid, deviceId) > 0;
    }

    get size() {
        return this.socketsById.size;
    }

    clear() {
        this.socketsById.clear();
        this.deviceSockets.clear();
    }
}

module.exports = { ActiveSocketsStore };
