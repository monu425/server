package com.example.hybridclient

import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM entry point.
 *
 * FCM data payload contains at least:
 *   eventId, eventType, targetUid, targetDeviceId, payload (JSON string), sentAt
 *
 * Remember:
 * - FirebaseMessagingService.onMessageReceived = Android process received the push.
 * - It is NOT the same as the application-level ACK that the Node backend wants.
 * - The backend only knows about receipt after the app reconnects and emits
 *   event:status (or event:ack) for that eventId.
 */
class HybridFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Called when FCM rotates the token. Forward it to the backend.
        HybridEventClient.updateFcmToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val eventId = data["eventId"]

        if (eventId.isNullOrEmpty()) {
            Log.w("HybridFcm", "Ignoring FCM message without eventId")
            return
        }

        val eventType = data["eventType"] ?: "UNKNOWN"
        val payloadJson = data["payload"]

        // The FCM service may start a fresh process. Re-create the client from
        // the existing Firebase Authentication session before reconnecting.
        val uid = FirebaseAuth.getInstance().currentUser?.uid
        if (uid == null) {
            Log.w("HybridFcm", "No Firebase user; cannot report event status")
            return
        }

        HybridEventClient.configure(applicationContext, uid)

        // Report receipt and processing status when the socket can reconnect.
        // For real work, enqueue a WorkManager job instead of doing it inline.
        HybridEventClient.processFcmEvent(eventId, eventType, payloadJson)
    }
}
