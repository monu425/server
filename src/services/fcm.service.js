"use strict";

/**
 * Firebase Cloud Messaging helpers.
 *
 * The service is deliberately tiny: it registers tokens, reads tokens and
 * performs exactly one send per call. There is no retry logic here.
 */
function createFcmService({ db, messaging, serverTimestamp, logger }) {
    function tokenPath(uid, deviceId) {
        return `fcmTokens/${uid}/${deviceId}`;
    }

    async function registerToken(uid, deviceId, token) {
        await db.ref(tokenPath(uid, deviceId)).set({
            token,
            updatedAt: serverTimestamp
        });
    }

    async function getToken(uid, deviceId) {
        const snapshot = await db
            .ref(`${tokenPath(uid, deviceId)}/token`)
            .once("value");

        if (!snapshot.exists()) return null;

        const token = snapshot.val();
        return typeof token === "string" && token.length > 0 ? token : null;
    }

    async function listDevices(uid) {
        const snapshot = await db.ref(`fcmTokens/${uid}`).once("value");

        if (!snapshot.exists()) return [];

        const value = snapshot.val() || {};
        const devices = [];

        for (const [deviceId, record] of Object.entries(value)) {
            if (
                record &&
                typeof record === "object" &&
                typeof record.token === "string" &&
                record.token.length > 0
            ) {
                devices.push({
                    deviceId,
                    token: record.token,
                    updatedAt: Number(record.updatedAt) || 0
                });
            }
        }

        return devices;
    }

    async function sendEvent({
        token,
        eventId,
        eventType,
        targetUid,
        targetDeviceId,
        payload
    }) {
        const message = {
            token,
            data: {
                eventId: String(eventId),
                eventType: String(eventType),
                targetUid: String(targetUid),
                targetDeviceId: String(targetDeviceId),
                payload: JSON.stringify(payload ?? {}),
                sentAt: String(Date.now()),
                schemaVersion: "1"
            },
            android: {
                // Firebase Admin Node SDK expresses Android TTL in milliseconds.
                // ttl: 0 means "deliver now or drop"; no long-lived messages.
                ttl: 0,
                priority: "high"
            }
        };

        const messageId = await messaging.send(message);

        logger.info("FCM message accepted by the API", {
            eventId,
            targetDeviceId,
            messageId
        });

        return messageId;
    }

    return {
        registerToken,
        getToken,
        listDevices,
        sendEvent
    };
}

module.exports = { createFcmService };
