"use strict";

const express = require("express");

function buildCorsOriginCheck(corsOrigins) {
    if (corsOrigins === "*") {
        return () => true;
    }

    const allowed = new Set(corsOrigins);

    return (origin) => !origin || allowed.has(origin);
}

function createApp({ config, logger, getStats }) {
    const app = express();
    const isOriginAllowed = buildCorsOriginCheck(config.corsOrigins);

    app.disable("x-powered-by");

    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        next();
    });

    app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allowed = isOriginAllowed(origin);

        res.setHeader("Vary", "Origin");

        if (allowed) {
            res.setHeader(
                "Access-Control-Allow-Origin",
                config.corsOrigins === "*" ? "*" : origin || "null"
            );
            res.setHeader(
                "Access-Control-Allow-Methods",
                "GET,POST,OPTIONS"
            );
            res.setHeader(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization"
            );
        }

        if (req.method === "OPTIONS") {
            res.status(allowed ? 204 : 403).end();
            return;
        }

        next();
    });

    app.use(express.json({ limit: "64kb" }));
    app.use(express.urlencoded({ extended: false, limit: "64kb" }));

    app.get("/", (req, res) => {
        res.json({
            service: "hybrid-websocket-fcm-backend",
            status: "running"
        });
    });

    app.get("/health", (req, res) => {
        const stats = typeof getStats === "function" ? getStats() : {};

        res.json({
            ok: true,
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
            ...stats
        });
    });

    app.get("/ready", (req, res) => {
        res.json({ ok: true });
    });

    app.use((req, res) => {
        res.status(404).json({
            ok: false,
            error: { code: "NOT_FOUND", message: "Route not found" }
        });
    });

    app.use((error, req, res, next) => {
        logger.error("HTTP request failed", {
            path: req.path,
            method: req.method,
            message: error.message
        });

        if (res.headersSent) {
            next(error);
            return;
        }

        res.status(500).json({
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "Internal server error" }
        });
    });

    return app;
}

module.exports = { createApp };
