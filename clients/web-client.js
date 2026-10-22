/**
 * Minimal Web client integration example.
 *
 * This file is intentionally standalone and is not imported by the server.
 * Use it as a starting point in a browser bundle or in a <script type="module">.
 *
 * The UID below must come from your existing Firebase Authentication flow.
 * The backend does not authenticate or verify it.
 */

import { io } from "https://cdn.jsdelivr.net/npm/socket.io-client@4.8.4/+esm";

const BACKEND_URL = "http://localhost:3000";

export function createHybridWebClient(options) {
    const uid = options.uid;
    const handlers = {
        onStatus: options.onStatus || (() => undefined),
        onPresence: options.onPresence || (() => undefined),
        onReady: options.onReady || (() => undefined),
        onError: options.onError || (() => undefined)
    };

    if (!uid) {
        throw new Error("A Firebase UID is required");
    }

    const socket = io(BACKEND_URL, {
        auth: {
            clientType: "web",
            uid
        },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000
    });

    socket.on("connection:ready", (info) => {
        handlers.onReady(info);
    });

    socket.on("connection:error", (error) => {
        handlers.onError(error);
    });

    socket.on("connect_error", (error) => {
        handlers.onError({
            code: "TRANSPORT_ERROR",
            message: error.message
        });
    });

    socket.on("disconnect", (reason) => {
        handlers.onError({
            code: "DISCONNECTED",
            message: reason
        });
    });

    socket.on("event:status", (status) => {
        // Status is delivered only to the socket that submitted the event.
        // eventId is the key for updating the correct UI row.
        handlers.onStatus(status);
    });

    socket.on("presence:status", (snapshot) => {
        handlers.onPresence(snapshot);
    });

    socket.on("presence:update", (update) => {
        handlers.onPresence(update);
    });

    /**
     * ACK callback = backend acceptance only.
     * Later Android receipt/processing arrives on event:status.
     */
    function sendEvent(request, timeoutMs = 8000) {
        return new Promise((resolve) => {
            if (!socket.connected) {
                resolve({
                    ok: false,
                    error: {
                        code: "NOT_CONNECTED",
                        message: "Socket.IO is not connected"
                    }
                });
                return;
            }

            socket.timeout(timeoutMs).emit(
                "event:send",
                {
                    targetUid: request.targetUid,
                    targetDeviceId: request.targetDeviceId,
                    eventType: request.eventType,
                    payload: request.payload
                },
                (timeoutError, response) => {
                    if (timeoutError) {
                        resolve({
                            ok: false,
                            error: {
                                code: "ACK_TIMEOUT",
                                message: "Backend did not acknowledge the event"
                            }
                        });
                        return;
                    }

                    resolve(response);
                }
            );
        });
    }

    function watchPresence(targetUid) {
        return new Promise((resolve) => {
            socket.timeout(5000).emit(
                "presence:watch",
                { uid: targetUid },
                (timeoutError, response) => {
                    if (timeoutError) {
                        resolve({
                            ok: false,
                            error: {
                                code: "ACK_TIMEOUT",
                                message: "Presence watch was not acknowledged"
                            }
                        });
                        return;
                    }

                    resolve(response);
                }
            );
        });
    }

    function unwatchPresence(targetUid) {
        return new Promise((resolve) => {
            socket.emit("presence:unwatch", { uid: targetUid }, resolve);
        });
    }

    function disconnect() {
        socket.disconnect();
    }

    return {
        socket,
        sendEvent,
        watchPresence,
        unwatchPresence,
        disconnect
    };
}

/*
Usage:

const client = createHybridWebClient({
  uid: firebaseCurrentUser.uid,
  onStatus(status) {
    console.log("event", status.eventId, "is now", status.status);
  },
  onPresence(presence) {
    console.log("presence", presence);
  },
  onError(error) {
    console.error(error.code, error.message);
  }
});

const ack = await client.sendEvent({
  targetUid: "receiver-firebase-uid",
  eventType: "TASK_UPDATE",
  payload: { taskId: "123", action: "refresh" }
});

if (!ack.ok) {
  console.error(ack.error);
}

await client.watchPresence("receiver-firebase-uid");
*/
