"use strict";

const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
};

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
    /(token|authorization|private[_ -]?key|secret|password|credential|payload)/i;

function normalizeLevel(level) {
    const value = typeof level === "string" ? level.toLowerCase() : "info";
    return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : "info";
}

function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return "[TRUNCATED]";

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            code: value.code,
            stack: value.stack
        };
    }

    if (Array.isArray(value)) {
        return value.map((item) => redact(item, depth + 1));
    }

    if (typeof value === "object") {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = SENSITIVE_KEY_PATTERN.test(key)
                ? REDACTED
                : redact(item, depth + 1);
        }
        return output;
    }

    if (typeof value === "string" && value.length > 512) {
        return `${value.slice(0, 512)}...[truncated]`;
    }

    return value;
}

function safeMeta(meta) {
    if (meta === undefined) return undefined;
    return redact(meta);
}

function createLogger(options = {}) {
    const level = normalizeLevel(options.level || process.env.LOG_LEVEL || "info");
    const threshold = LEVELS[level];
    const bindings = options.bindings || {};

    function write(levelName, message, meta) {
        if (LEVELS[levelName] < threshold) return;

        const record = {
            ts: new Date().toISOString(),
            level: levelName,
            msg: String(message),
            ...bindings
        };

        const safe = safeMeta(meta);
        if (safe !== undefined) {
            record.meta = safe;
        }

        const line = JSON.stringify(record);

        if (levelName === "error") {
            console.error(line);
        } else if (levelName === "warn") {
            console.warn(line);
        } else {
            console.log(line);
        }
    }

    return {
        level,
        debug: (message, meta) => write("debug", message, meta),
        info: (message, meta) => write("info", message, meta),
        warn: (message, meta) => write("warn", message, meta),
        error: (message, meta) => write("error", message, meta),
        child: (childBindings) =>
            createLogger({ level, bindings: { ...bindings, ...childBindings } })
    };
}

const logger = createLogger();

module.exports = {
    createLogger,
    logger,
    redact,
    REDACTED
};
