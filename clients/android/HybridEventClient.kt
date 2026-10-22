package com.example.hybridclient

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Minimal Socket.IO integration example for the hybrid backend.
 *
 * Dependencies (app/build.gradle):
 *
 * implementation("io.socket:socket.io-client:2.1.1") {
 *     exclude(group = "org.json", module = "json")
 * }
 * implementation("com.google.firebase:firebase-messaging:24.1.0")
 * implementation("com.google.firebase:firebase-auth:23.1.0")
 *
 * This example is intentionally not a full production service. Use a
 * foreground service or WorkManager for durable business processing.
 */
object HybridEventClient {
    private const val TAG = "HybridEventClient"
    private const val BACKEND_URL = "http://10.0.2.2:3000" // Android emulator -> localhost
    private const val PREFS = "hybrid_client"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_FCM_TOKEN = "fcm_token"

    private lateinit var appContext: Context
    private var uid: String? = null
    private var socket: Socket? = null

    // Best-effort only. This set is lost when the Android process dies.
    private val processedEventIds = ConcurrentHashMap.newKeySet<String>()

    // Latest status per event while offline. Not durable, not a queue.
    private val pendingStatusReports = ConcurrentHashMap<String, String>()

    private val heartbeatExecutor = Executors.newSingleThreadScheduledExecutor()

    @Volatile
    private var heartbeatStarted = false

    @Volatile
    private var fcmToken: String? = null

    /**
     * Call once from your Activity/Application after Firebase Authentication
     * has produced a UID.
     */
    @Synchronized
    fun configure(context: Context, firebaseUid: String) {
        appContext = context.applicationContext
        uid = firebaseUid
        fcmToken = appContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_FCM_TOKEN, null)

        ensureConnected()
        startHeartbeat()
    }

    fun stableDeviceId(): String {
        val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_DEVICE_ID, null)

        if (existing != null) return existing

        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
        return generated
    }

    @Synchronized
    fun ensureConnected() {
        val currentUid = uid ?: return

        val existing = socket
        if (existing != null) {
            if (!existing.connected()) existing.connect()
            return
        }

        val options = IO.Options().apply {
            auth = mapOf(
                "clientType" to "android",
                "uid" to currentUid,
                "deviceId" to stableDeviceId()
            )
            transports = arrayOf(WebSocket.NAME)
            reconnection = true
            reconnectionDelay = 500
            reconnectionDelayMax = 5000
        }

        val newSocket = IO.socket(BACKEND_URL, options)
        socket = newSocket

        newSocket.on(Socket.EVENT_CONNECT) {
            Log.i(TAG, "Socket.IO connected: ${newSocket.id()}")
            registerCurrentFcmToken()
            flushPendingStatusReports()
        }

        newSocket.on(Socket.EVENT_DISCONNECT) { args ->
            Log.i(TAG, "Socket.IO disconnected: ${args.firstOrNull()}")
        }

        newSocket.on(Socket.EVENT_CONNECT_ERROR) { args ->
            Log.w(TAG, "Socket.IO connect error: ${args.firstOrNull()}")
        }

        newSocket.on("event:deliver") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            val ack = args.getOrNull(1) as? Ack
            val eventId = data.optString("eventId")

            if (eventId.isEmpty()) return@on

            // Acknowledge receipt IMMEDIATELY. Do not wait for processing.
            // The ACK callback is the fastest path. Sending RECEIVED explicitly
            // is optional and idempotent on the server.
            ack?.call(JSONObject().put("status", "RECEIVED"))
            emitStatus(eventId, "RECEIVED")

            // Best-effort duplicate protection. Does not survive process death.
            if (!processedEventIds.add(eventId)) return@on
            if (processedEventIds.size > 2000) processedEventIds.clear()

            emitStatus(eventId, "PROCESSING")

            try {
                handleBusinessEvent(
                    data.optString("eventType"),
                    data.optJSONObject("payload") ?: JSONObject()
                )
                emitStatus(eventId, "COMPLETED")
            } catch (error: Exception) {
                emitStatus(eventId, "FAILED", error.message)
            }
        }

        newSocket.connect()
    }

    fun updateFcmToken(token: String) {
        fcmToken = token

        if (::appContext.isInitialized) {
            appContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_FCM_TOKEN, token)
                .apply()

            sendTokenIfConnected(token)
        }
    }

    private fun registerCurrentFcmToken() {
        val cached = fcmToken
        if (cached != null) {
            sendTokenIfConnected(cached)
            return
        }

        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                updateFcmToken(task.result)
            } else {
                Log.w(TAG, "Could not obtain FCM token")
            }
        }
    }

    private fun sendTokenIfConnected(token: String) {
        val active = socket ?: return
        if (!active.connected()) return

        active.emit(
            "android:register-fcm",
            JSONObject().put("token", token),
            Ack { args ->
                val response = args.firstOrNull() as? JSONObject
                if (response?.optBoolean("ok") != true) {
                    Log.w(TAG, "FCM token registration rejected")
                }
            }
        )
    }

    fun emitStatus(eventId: String, status: String, message: String? = null) {
        val active = socket

        if (active == null || !active.connected()) {
            // Do not build a durable queue. Keep only the latest status in
            // memory and try to reconnect. If the process dies, it is lost.
            pendingStatusReports[eventId] = status
            ensureConnected()
            return
        }

        val payload = JSONObject()
            .put("eventId", eventId)
            .put("status", status)

        if (!message.isNullOrBlank()) {
            payload.put("message", message.take(500))
        }

        active.emit("event:status", payload)
    }

    /**
     * Called by the FCM service when a data message arrives. The application
     * may be in the background or the socket may be closed.
     */
    fun processFcmEvent(eventId: String, eventType: String, payloadJson: String?) {
        ensureConnected()

        if (!processedEventIds.add(eventId)) return
        if (processedEventIds.size > 2000) processedEventIds.clear()

        emitStatus(eventId, "RECEIVED")
        emitStatus(eventId, "PROCESSING")

        try {
            val payload = payloadJson?.let { JSONObject(it) } ?: JSONObject()
            handleBusinessEvent(eventType, payload)
            emitStatus(eventId, "COMPLETED")
        } catch (error: Exception) {
            emitStatus(eventId, "FAILED", error.message)
        }
    }

    private fun flushPendingStatusReports() {
        val active = socket ?: return
        if (!active.connected()) return

        val iterator = pendingStatusReports.entries.iterator()

        while (iterator.hasNext()) {
            val entry = iterator.next()
            emitStatus(entry.key, entry.value)
            iterator.remove()
        }
    }

    private fun startHeartbeat() {
        if (heartbeatStarted) return
        heartbeatStarted = true

        heartbeatExecutor.scheduleAtFixedRate(
            {
                val active = socket
                if (active != null && active.connected()) {
                    active.emit("presence:heartbeat", JSONObject())
                }
            },
            0,
            30,
            TimeUnit.SECONDS
        )
    }

    /**
     * Replace with your application logic. Do not log payloads or FCM tokens.
     */
    private fun handleBusinessEvent(eventType: String, payload: JSONObject) {
        when (eventType) {
            "TASK_UPDATE" -> Log.i(TAG, "Applying TASK_UPDATE event")
            "NOTIFICATION" -> Log.i(TAG, "Applying NOTIFICATION event")
            "SYNC" -> Log.i(TAG, "Applying SYNC event")
            else -> Log.i(TAG, "Applying event type=$eventType")
        }

        // e.g. refresh a local task list using payload.optString("taskId")
    }

    @Synchronized
    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }
}
