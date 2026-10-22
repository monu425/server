"use strict";

const fs = require("fs");
const {
    initializeApp,
    getApps,
    cert,
    applicationDefault
} = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

function normalizePrivateKey(privateKey) {
    if (typeof privateKey !== "string" || privateKey.length === 0) {
        throw new Error("Firebase private key must be a non-empty string");
    }

    return privateKey.replace(/\\n/g, "\n");
}

function parseServiceAccountJson(raw, source) {
    let parsed;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${source} does not contain valid JSON`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${source} must contain a JSON object`);
    }

    if (typeof parsed.private_key === "string") {
        parsed.private_key = normalizePrivateKey(parsed.private_key);
    }

    return parsed;
}

function buildCredential(config, logger) {
    if (config.firebaseServiceAccountJson) {
        logger.info("Firebase credentials loaded from inline JSON");
        return cert(
            parseServiceAccountJson(
                config.firebaseServiceAccountJson,
                "FIREBASE_SERVICE_ACCOUNT_JSON"
            )
        );
    }

    if (config.firebaseServiceAccountPath) {
        const raw = fs.readFileSync(config.firebaseServiceAccountPath, "utf8");
        logger.info("Firebase credentials loaded from service account file");
        return cert(
            parseServiceAccountJson(
                raw,
                "FIREBASE_SERVICE_ACCOUNT_PATH"
            )
        );
    }

    if (
        config.firebaseProjectId &&
        config.firebaseClientEmail &&
        config.firebasePrivateKey
    ) {
        logger.info("Firebase credentials loaded from individual env fields");
        return cert({
            projectId: config.firebaseProjectId,
            clientEmail: config.firebaseClientEmail,
            privateKey: normalizePrivateKey(config.firebasePrivateKey)
        });
    }

    logger.info(
        "No explicit Firebase credential found; using Application Default Credentials"
    );
    return applicationDefault();
}

function initFirebase(config, logger) {
    const existing = getApps();

    if (existing.length > 0) {
        logger.warn("Firebase Admin SDK already initialized; reusing the app");
        const app = existing[0];

        return {
            app,
            db: getDatabase(app),
            messaging: getMessaging(app),
            serverTimestamp: ServerValue.TIMESTAMP
        };
    }

    const options = {
        databaseURL: config.firebaseDatabaseUrl
    };

    if (config.firebaseProjectId) {
        options.projectId = config.firebaseProjectId;
    }

    options.credential = buildCredential(config, logger);

    const app = initializeApp(options);

    return {
        app,
        db: getDatabase(app),
        messaging: getMessaging(app),
        serverTimestamp: ServerValue.TIMESTAMP
    };
}

module.exports = { initFirebase };
