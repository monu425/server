"use strict";

/**
 * Very small fixed-window rate limiter scoped to a single socket.
 * State lives on socket.data, so it is released when the socket disconnects.
 *
 * It is intentionally per-process. For multiple backend instances a shared
 * limiter would be required, but this implementation targets one instance.
 */
function createSocketRateLimiter(options = {}) {
    const windowMs = options.windowMs ?? 60000;
    const limits = options.limits || {};
    const now = options.now || (() => Date.now());

    function allow(socket, action) {
        const limit = limits[action];

        if (!Number.isFinite(limit) || limit <= 0) {
            return true;
        }

        if (!socket || typeof socket !== "object") {
            return false;
        }

        if (!socket.data || typeof socket.data !== "object") {
            socket.data = {};
        }

        if (!socket.data.rateLimits || typeof socket.data.rateLimits !== "object") {
            socket.data.rateLimits = {};
        }

        const timestamp = now();
        let bucket = socket.data.rateLimits[action];

        if (!bucket || timestamp >= bucket.resetAt) {
            bucket = {
                count: 0,
                resetAt: timestamp + windowMs
            };
            socket.data.rateLimits[action] = bucket;
        }

        bucket.count += 1;

        return bucket.count <= limit;
    }

    return { allow, limits, windowMs };
}

module.exports = { createSocketRateLimiter };
