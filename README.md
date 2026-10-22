# Hybrid WebSocket + FCM Backend

Real-time event delivery backend built with **Node.js, Express, Socket.IO, Firebase Admin SDK, Realtime Database (RTDB) and FCM**.

Yeh backend do kaam karta hai:

1. Web client se event leta hai.
2. Agar target Android device ka live Socket.IO connection hai to event seedha usi par bhejta hai.
3. Android app se turant receipt ACK leta hai.
4. ACK time par nahi aaya, ya socket disconnect ho gaya, to **sirf ek baar** FCM fallback karta hai.
5. Presence aur FCM token sirf RTDB me rakhta hai. Event payload ya event history kabhi persist nahi hoti.

Backend me authentication nahi hai. Yeh **explicit requirement** hai. Web aur Android clients Firebase Authentication khud handle karte hain, aur Socket.IO connection par apna Firebase UID aur device info bhejte hain. Backend un values ko **client-supplied identifiers** ki tarah treat karta hai, verified identity ki tarah nahi. Iska matlab hai ki koi caller doosra UID claim kar sakta hai. Production me strong authorization chahiye to yeh design change karna hoga.

---

## 1. Architecture and message flow

```text
                 event:send (ACK = ACCEPTED)
  Web browser  -------------------------------------->  Node backend
  (Socket.IO)                                          (single instance)
      ^                                                  |
      | event:status (origin socket id only)             | event:deliver
      |                                                  v
      +--------------------------------------------  Android app
                                                       (Socket.IO)

  ACK missing / socket disconnected / no live socket
                     |
                     v
              FCM send (exactly once, no retry)
```

### Delivery flow

1. Web app `event:send` emit karta hai. Payload me `targetUid`, optional `targetDeviceId`, `eventType` aur `payload` hota hai.
2. Backend request validate karta hai, server-side UUID `eventId` banata hai, origin `socket.id` ke saath **in-memory** metadata rakhta hai.
3. Target device select hota hai (policy neeche di hai).
4. Live Android connection mila to `event:deliver` usi socket par jata hai. Status `SENT_WS` report hota hai.
5. Android app ko event milte hi **turant** ACK dena chahiye. Do supported tarike hain:
   - `event:deliver` ke Socket.IO ACK callback me `{ status: "RECEIVED" }` return karna, ya
   - turant `event:status` emit karna with `status: "RECEIVED"`, ya
   - `event:ack` emit karna with `{ eventId }`.
6. Receipt ACK aa gaya to ACK timer cancel hota hai aur FCM nahi jata.
7. Live connection nahi hai to FCM attempt **immediately** start hota hai. ACK timer ka wait nahi hota.
8. Live connection ACK se pehle disconnect ho gaya to fallback immediately start hota hai.
9. ACK time out ho gaya (default `12000 ms`) to FCM attempt exactly once hota hai.
10. FCM token missing ya FCM send fail hua to status `DISCARDED` hota hai. Retry nahi hota.
11. FCM ne message accept kiya to status `FCM_ACCEPTED` hota hai. Yeh Android receipt nahi hai.
12. FCM accept ke baad Android app-level receipt ke liye finite window (`POST_FCM_CONFIRM_TIMEOUT_MS`) wait hota hai. Receipt na aaye to `DELIVERY_UNCONFIRMED` aur in-memory cleanup.

### Race safety

`fallbackOnce(eventId, reason)` hi FCM attempt ka single entry point hai.

- `fallbackAttempted` flag **synchronously** set hota hai, kisi bhi await / RTDB / FCM call se pehle.
- ACK timeout, socket disconnect, aur duplicate timer callbacks sab isi function me aate hain.
- Node.js single-threaded event loop ki wajah se pehla caller flag set kar deta hai; baaki callers `false` return karte hain.
- Late ACK FCM attempt ke baad aa sakta hai. Us case me FCM dobara nahi jata; backend observed receipt ko `RECEIVED` record karta hai, aur already in-flight FCM result ko `FCM_ACCEPTED` me downgrade nahi karta.

### Duplicate delivery

Exactly-once delivery guarantee nahi hai. Ek duplicate possible hai:

- ACK timeout par FCM bhej diya gaya.
- Usi waqt Socket.IO ACK late aa gaya, aur Android ne FCM message bhi receive kar liya.

Isliye Android app ko `eventId` ke basis par **best-effort deduplication** karni chahiye. Example me in-memory `Set<String>` use hua hai. Yeh set Android process restart ke baad nahi bachta, isliye durable dedupe chahiye to app apni business layer me kare.

### Device selection policy

1. `targetDeviceId` diya gaya hai to sirf wahi device use hota hai.
2. `targetDeviceId` nahi diya:
   - UID ke active Android sockets me se **deterministic** device chuna jata hai (lexicographically smallest `deviceId`).
   - Active socket nahi hai to RTDB ke FCM tokens me se **most recently registered** device chuna jata hai (`updatedAt` descending, tie par `deviceId` ascending).
3. Same event kabhi bhi saare devices par broadcast nahi hota.

`eventType` kabhi bhi dynamic Socket.IO event name nahi banta. Fixed event name `event:deliver` hai aur validated `eventType` payload ke andar jata hai.

---

## 2. RTDB schema and status state machine

### Realtime Database schema

```json
{
  "presence": {
    "receiver-firebase-uid": {
      "devices": {
        "android-device-1": {
          "uid": "receiver-firebase-uid",
          "deviceId": "android-device-1",
          "status": "online",
          "connectionCount": 1,
          "lastConnectedAt": 1710000000000,
          "lastSeen": 1710000000000,
          "lastHeartbeatAt": 1710000000000,
          "updatedAt": 1710000000000,
          "stale": false,
          "offlineReason": null
        }
      }
    }
  },
  "fcmTokens": {
    "receiver-firebase-uid": {
      "android-device-1": {
        "token": "fcm-registration-token",
        "updatedAt": 1710000000000
      }
    }
  }
}
```

Rules:

- RTDB me sirf yeh do roots use hote hain: `presence/{uid}/devices/{deviceId}` aur `fcmTokens/{uid}/{deviceId}`.
- Koi `events`, `eventHistory`, `deliveries`, `acks` ya `queue` path nahi hai.
- Event payload, event history, ACK records, processing history ya delivery queue RTDB me kabhi nahi likhe jate.
- FCM token Web client ko kabhi return nahi hota. Logs me bhi nahi jata.
- Server timestamps ke liye Firebase `ServerValue.TIMESTAMP` use hota hai.

### Status values

| Status | Meaning |
| --- | --- |
| `ACCEPTED` | Backend ne event accept kiya aur processing start ki. |
| `SENT_WS` | Event Socket.IO par emit hua. |
| `RECEIVED` | Android app ne event receive karke receipt ACK diya. |
| `PROCESSING` | Android ne processing start ki. |
| `COMPLETED` | Android processing successful. |
| `FAILED` | Android processing failed. |
| `FCM_ATTEMPTED` | Backend ne single allowed FCM attempt start kiya. |
| `FCM_ACCEPTED` | FCM API ne message accept kiya. Android receipt nahi. |
| `DISCARDED` | Token missing tha ya FCM send fail hua. |
| `DELIVERY_UNCONFIRMED` | Post-FCM window me Android app-level receipt confirm nahi hua. |

### Allowed transitions

```text
ACCEPTED      -> SENT_WS | RECEIVED | FCM_ATTEMPTED | DISCARDED
SENT_WS       -> RECEIVED | FCM_ATTEMPTED | DISCARDED
RECEIVED      -> PROCESSING | COMPLETED | FAILED
PROCESSING    -> COMPLETED | FAILED
FCM_ATTEMPTED -> FCM_ACCEPTED | RECEIVED | DISCARDED
FCM_ACCEPTED  -> RECEIVED | PROCESSING | COMPLETED | FAILED | DELIVERY_UNCONFIRMED
COMPLETED     -> (terminal)
FAILED        -> (terminal)
DISCARDED     -> (terminal)
DELIVERY_UNCONFIRMED -> (terminal)
```

`COMPLETED` terminal hai. Uske baad koi `PROCESSING` ya koi aur live status usse overwrite nahi kar sakta.

---

## 3. Project directory tree

```text
hybrid-backend/
  src/
    server.js
    app.js
    config/
      env.js
      firebase.js
    sockets/
      index.js
      handlers/
        web.handlers.js
        android.handlers.js
        presence.handlers.js
    services/
      event.service.js
      delivery.service.js
      fcm.service.js
      presence.service.js
    stores/
      activeSockets.store.js
      pendingEvents.store.js
    utils/
      validators.js
      logger.js
      statusMachine.js
      rateLimiter.js
  tests/
    delivery.test.js
    event-service.test.js
    integration.test.js
    config.test.js
    presence.test.js
    storage.test.js
    validation.test.js
    helpers/
      fakes.js
      fixtures.js
      testServer.js
  clients/
    web-client.js
    android/
      HybridEventClient.kt
      HybridFirebaseMessagingService.kt
  firebase/
    database.rules.json
    README.md
  .env.example
  .gitignore
  package.json
  README.md
```

---

## 4. Socket.IO protocol

### Web client -> backend

```text
event:send
```

Request:

```json
{
  "targetUid": "receiver-firebase-uid",
  "targetDeviceId": "optional-device-id",
  "eventType": "TASK_UPDATE",
  "payload": {
    "taskId": "123",
    "action": "refresh"
  }
}
```

ACK callback only backend acceptance batata hai:

```json
{
  "ok": true,
  "eventId": "server-generated-uuid",
  "status": "ACCEPTED",
  "acceptedAt": 1710000000000
}
```

Error ACK:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_EVENT",
    "message": "Event request validation failed",
    "details": ["payload exceeds the 4096 byte limit"]
  }
}
```

Possible error codes: `INVALID_EVENT`, `RATE_LIMITED`, `SERVER_BUSY`, `FORBIDDEN_CLIENT_TYPE`, `INTERNAL_ERROR`.

### Backend -> Web client

```text
event:status
```

```json
{
  "eventId": "server-generated-uuid",
  "status": "RECEIVED",
  "eventType": "TASK_UPDATE",
  "targetUid": "receiver-firebase-uid",
  "targetDeviceId": "android-device-1",
  "timestamp": 1710000000123,
  "source": "socket-ack-callback"
}
```

Yeh notification **sirf originating `socket.id`** ko jata hai. UID ke doosre sockets ko nahi. Origin Web socket disconnect ho gaya to update drop ho jata hai; replay ke liye save nahi hota.

### Presence events

```text
presence:watch    { "uid": "target-uid" }   (ACK returns snapshot)
presence:unwatch  { "uid": "target-uid" }
presence:status   (server -> client initial snapshot)
presence:update   (server -> watching client live update)
presence:heartbeat (Android -> server)
```

Initial snapshot example:

```json
{
  "uid": "target-uid",
  "online": true,
  "devices": [
    {
      "deviceId": "android-device-1",
      "online": true,
      "source": "socket",
      "connectionCount": 1
    }
  ],
  "source": "socket",
  "checkedAt": 1710000000000
}
```

Agar current process me us device ka live Socket.IO socket nahi hai, to RTDB snapshot sirf informational hota hai: `online` false rahega, `reportedOnline` last RTDB value batata hai, aur `stale` freshness threshold se set hota hai. Delivery decisions kabhi sirf RTDB presence par nahi hote.

Presence watch authorization nahi hai. Koi bhi caller kisi bhi UID ko watch kar sakta hai, kyunki backend authentication explicitly disabled hai.

### Android client -> backend

```text
android:register-fcm  { "token": "fcm-token" }       (ACK)
event:ack             { "eventId": "uuid" }          (ACK)
event:status          { "eventId": "uuid", "status": "PROCESSING", "message": "optional" } (ACK)
presence:heartbeat    {}                              (ACK)
```

Android sirf `RECEIVED`, `PROCESSING`, `COMPLETED`, `FAILED` report kar sakta hai.

### Backend -> Android client

```text
event:deliver
```

```json
{
  "eventId": "server-generated-uuid",
  "eventType": "TASK_UPDATE",
  "targetUid": "receiver-firebase-uid",
  "targetDeviceId": "android-device-1",
  "payload": {
    "taskId": "123",
    "action": "refresh"
  },
  "sentAt": 1710000000000
}
```

Socket.IO ACK callback optional hai. Explicit `event:status` with `RECEIVED` bhi valid ACK hai.

### Connection handshake

```js
// Web
io(BACKEND_URL, {
  auth: { clientType: "web", uid: firebaseUser.uid }
});

// Android
options.auth = {
  clientType: "android",
  uid: firebaseUser.uid,
  deviceId: stableDeviceId
};
```

Invalid handshake par server `connection:error` bhejkar socket disconnect kar deta hai.

`connection:ready` event milta hai:

```json
{
  "socketId": "...",
  "clientType": "web",
  "uid": "...",
  "deviceId": null,
  "serverTime": 1710000000000,
  "ackTimeoutMs": 12000,
  "payloadMaxBytes": 4096,
  "allowedEventTypes": ["TASK_UPDATE", "NOTIFICATION", "WAKEUP", "SYNC"]
}
```

---

## 5. Environment variables

`.env.example` copy karo:

```bash
cd hybrid-backend
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / Socket.IO port |
| `CORS_ORIGINS` | `*` | Comma separated allow-list. Production me exact origins do. |
| `FIREBASE_DATABASE_URL` | required | RTDB URL |
| `ACK_TIMEOUT_MS` | `12000` | Receipt ACK timeout. `10000` / `15000` bhi valid hain. |
| `POST_FCM_CONFIRM_TIMEOUT_MS` | `60000` | FCM accept ke baad Android receipt window |
| `EVENT_CLEANUP_GRACE_MS` | `5000` | Terminal status ke baad in-memory record retention |
| `EVENT_HARD_TIMEOUT_MS` | `300000` | Absolute memory safety valve |
| `EVENT_PAYLOAD_MAX_BYTES` | `4096` | Serialized payload limit (FCM data limit aligned) |
| `ALLOWED_EVENT_TYPES` | `TASK_UPDATE,NOTIFICATION,WAKEUP,SYNC` | Allow-list |
| `MAX_IN_FLIGHT_EVENTS` | `10000` | In-memory event cap |
| `PRESENCE_STALE_MS` | `120000` | RTDB presence freshness threshold |
| `PRESENCE_HEARTBEAT_WRITE_MS` | `30000` | Heartbeat RTDB write throttle |
| `RECONCILE_PRESENCE_ON_START` | `true` | Single-instance startup reconciliation |

Yeh validation startup par hoti hai. Missing `FIREBASE_DATABASE_URL` ya invalid numeric value par server fail-fast karta hai.

---

## 6. Firebase setup

### 6.1 Realtime Database

1. Firebase console me project open karo.
2. **Build -> Realtime Database** enable karo.
3. Database URL copy karo, e.g. `https://your-project-default-rtdb.firebaseio.com`.
4. `FIREBASE_DATABASE_URL` me set karo.
5. Rules ke liye `firebase/database.rules.json` ka section dekho.

### 6.2 Cloud Messaging

1. Firebase project me Cloud Messaging enabled hona chahiye.
2. Android app Firebase project se register hona chahiye (`google-services.json`).
3. Android app `FirebaseMessagingService` implement kare aur latest token `android:register-fcm` se bheje.
4. Backend FCM send ke liye service account / ADC use karta hai.

### 6.3 Server credentials

Teen supported tarike hain. Koi ek chuno:

**Option A: Inline JSON**

```env
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

**Option B: JSON file path**

```env
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/secrets/firebase-service-account.json
```

**Option C: Individual fields**

```env
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**Option D: Application Default Credentials**

Koi credential variable set na karo. GCP / Cloud Run / GKE par `GOOGLE_APPLICATION_CREDENTIALS` ya workload identity use karo. Firebase Admin SDK `applicationDefault()` use karega.

Service account private key **kabhi commit na karo**. `.gitignore` me `service-account*.json` aur `.env` already excluded hain. Production me secret manager use karo.

Admin SDK Firebase Security Rules ko bypass karta hai. Isliye backend RTDB writes rules se block nahi hote; rules sirf client access control karte hain.

---

## 7. Run locally

```bash
cd hybrid-backend

# Install dependencies
npm install

# Create local env file and fill Firebase values
cp .env.example .env

# Syntax checks
npm run check

# Unit + integration tests (no real Firebase required)
npm test

# Start development server
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Expected shape:

```json
{
  "ok": true,
  "uptimeSeconds": 12,
  "timestamp": "2026-01-01T00:00:00.000Z",
  "socketClients": 0,
  "activeSockets": 0,
  "inFlightEvents": 0
}
```

Production start:

```bash
npm start
```

Graceful shutdown `SIGINT` / `SIGTERM` par timers clear karta hai, Socket.IO close karta hai aur in-memory state drop karta hai.

---

## 8. Client integration

### Web JavaScript

Full example: `clients/web-client.js`.

```js
import { io } from "https://cdn.jsdelivr.net/npm/socket.io-client@4.8.4/+esm";

const socket = io("https://your-backend.example.com", {
  auth: {
    clientType: "web",
    uid: firebaseCurrentUser.uid // already authenticated on the client
  },
  transports: ["websocket", "polling"]
});

socket.on("connection:ready", (info) => {
  console.log("connected", info.socketId);
});

socket.on("connection:error", (error) => {
  console.error("connection rejected", error.code);
});

socket.on("connect_error", (error) => {
  console.error("transport error", error.message);
});

socket.on("event:status", (status) => {
  // status.eventId -> UI row update
});

function sendEvent(request) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit("event:send", request, (error, response) => {
      if (error) {
        resolve({ ok: false, error: { code: "ACK_TIMEOUT" } });
        return;
      }
      resolve(response);
    });
  });
}

const accepted = await sendEvent({
  targetUid: "receiver-firebase-uid",
  eventType: "TASK_UPDATE",
  payload: { taskId: "123", action: "refresh" }
});

socket.emit("presence:watch", { uid: "receiver-firebase-uid" }, (snapshot) => {
  console.log("presence snapshot", snapshot);
});

// later
socket.emit("presence:unwatch", { uid: "receiver-firebase-uid" });
```

### Android Kotlin

Full examples:

- `clients/android/HybridEventClient.kt`
- `clients/android/HybridFirebaseMessagingService.kt`

Key points:

- Stable application-generated `deviceId` use karo (SharedPreferences).
- Socket.IO client/server version compatible rakho: server `socket.io` 4.x, Android `io.socket:socket.io-client:2.1.1`.
- Connect ke waqt `clientType`, `uid`, `deviceId` bhejo.
- FCM token milne par aur refresh hone par `android:register-fcm` bhejo.
- `event:deliver` par turant ACK do, processing complete hone ka wait mat karo.
- `eventId` se best-effort duplicate protection rakho.
- FCM received event ko execute karke, reconnect hone par `RECEIVED` / `PROCESSING` / `COMPLETED` / `FAILED` report karo.
- Socket.IO connection hamesha open nahi hota, isliye FCM handler independent hona chahiye.

FCM data values strings hoti hain. Backend `eventId`, `eventType`, `targetUid`, `targetDeviceId`, serialized `payload`, `sentAt` bhejta hai. Android FCM handler `eventId` nikaal kar status report kar sakta hai.

FCM ke three separate outcomes samjho:

1. **FCM API accepted** the message (`FCM_ACCEPTED`).
2. **Device received** the push (Google/OS level; backend ko pata nahi).
3. **Application received and executed** the event (app-level `RECEIVED` / `COMPLETED`).

Backend sirf teesre outcome ko app-level ACK maanta hai.

---

## 9. RTDB security rules

Recommended rules file: `firebase/database.rules.json`.

```json
{
  "rules": {
    "presence": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        "devices": {
          "$deviceId": {
            ".write": false
          }
        }
      }
    },
    "fcmTokens": {
      ".read": false,
      ".write": false
    }
  }
}
```

Important:

- Yeh file **sirf naye paths** ke liye example hai. Apni existing rules file ko overwrite mat karo; in keys ko carefully merge karo.
- Existing parent rules (jaise root par broad `.read`) inherit ho sakte hain. Unrelated data ke rules change mat karo.
- Backend Admin SDK writes rules bypass karta hai. Isliye `presence` aur `fcmTokens` ke client writes `false` rakh sakte ho.
- Web clients ko presence backend ke through milta hai, direct RTDB read ki zaroorat nahi. Agar client ko direct read chahiye to sirf apne UID ke `presence` tak limited access do.
- `fcmTokens` ko client read/write se hamesha block karo.

---

## 10. In-memory state, timers and cleanup

Stores:

- `ActiveSocketsStore`: `socketId -> socket record`, plus `uid:deviceId -> Set<socketId>` for Android.
- `PendingEventsStore`: `eventId -> transient metadata`.
- Presence watchers: in-memory maps only.

Event metadata includes `eventId`, `originSocketId`, `targetUid`, `targetDeviceId`, current status, `ackReceived`, `fallbackAttempted`, target socket id, timers and timestamps. Payload sirf tab tak rakha jata hai jab tak delivery ke liye zaroori ho; ACK ya fallback ke baad reference release ho jata hai.

Timers:

- `ack`: receipt ACK timeout.
- `fcmConfirm`: FCM accept ke baad Android receipt window.
- `cleanup`: terminal status ke baad cleanup grace.
- `lifetime`: absolute safety valve. Agar client terminal status kabhi nahi bhejta (for example `RECEIVED` ke baad `COMPLETED` nahi aata), record hard timeout par drop hota hai.

`fallbackAttempted` repeated FCM attempts rokta hai. `clearTimers` har terminal path par call hota hai. `delivery.shutdown()` sab timers clear karta hai. `MAX_IN_FLIGHT_EVENTS` se memory unbounded nahi hoti.

**Restart behavior:** process restart par saare in-flight event records aur timers lost ho jate hain. RTDB se events reconstruct nahi hote aur retry nahi hota. Presence ke liye startup reconciliation leftover `online` entries ko `offline` mark karta hai (single instance assumption).

---

## 11. Multi-instance deployment notes (documented, not implemented)

Yeh implementation single Node.js instance ke liye hai. Multiple instances chahiye to:

1. **Socket.IO adapter** add karo (Redis adapter / compatible pub-sub) taaki kisi bhi instance se kisi bhi socket par event emit ho sake.
2. **Origin socket routing** ke liye socket ids globally addressable hone chahiye. Adapter ke saath `io.to(socketId)` kaam karta hai, lekin same `socket.id` collision na ho.
3. **Shared in-flight registry** chahiye (Redis ya similar). Warna ACK timeout/disconnect different instances par process ho sakta hai.
4. **Distributed fallback lock** chahiye taaki ek event ke liye globally ek hi FCM attempt ho (`SET NX` + TTL type lock, plus idempotency key).
5. **Presence ownership:** kaun sa instance kis device ka owner hai, heartbeat lease ke saath track karo. Startup reconciliation blindly sab offline na kare.
6. **Rate limiting** shared store par move karo.
7. **Sticky sessions** ya websocket-only transport use karo, warna polling transport ke multiple requests different instances par ja sakte hain.
8. **Timers** distributed scheduler me move karo, ya ownership ke saath single owner instance par run karo.

Is implementation me Redis, Kafka, BullMQ, koi distributed adapter ya persistent queue intentionally nahi hai.

---

## 12. Tests

Automated tests real Firebase ke bina chalti hain. Fake RTDB, fake FCM messaging aur real Socket.IO integration server use hota hai.

```bash
cd hybrid-backend
npm test
```

Coverage:

| Acceptance criterion | Test |
| --- | --- |
| Connected Android receives over Socket.IO | `integration.test.js`, `delivery.test.js` |
| Timely ACK prevents FCM | `delivery.test.js` |
| No connection -> one immediate FCM | `delivery.test.js`, `integration.test.js` |
| Missing ACK -> one fallback after timeout | `delivery.test.js` |
| Disconnect + timeout race -> no duplicate FCM | `delivery.test.js` |
| Missing token -> `DISCARDED` | `delivery.test.js` |
| FCM failure -> `DISCARDED`, no retry | `delivery.test.js` |
| FCM accepted != Android receipt | `delivery.test.js`, `integration.test.js` |
| Android status reaches origin Web socket | `event-service.test.js`, `integration.test.js` |
| Disconnected origin gets no replay | `delivery.test.js` |
| Device stays online while another socket active | `presence.test.js` |
| User online if at least one device online | `presence.test.js` |
| Payload never written to RTDB | `storage.test.js` |
| No persistent queue / retry | `storage.test.js`, `delivery.test.js` |
| Stale presence not trusted | `presence.test.js` |
| Timers and records cleaned up | `delivery.test.js` |
| Invalid / oversized payload rejected | `validation.test.js`, `event-service.test.js` |

### Manual end-to-end checklist

1. `.env` me valid Firebase RTDB URL aur service account set karo.
2. `npm start`.
3. `GET /health` check karo.
4. Web client connect karo with `clientType: "web"` and a UID.
5. Android client connect karo with same target UID and stable `deviceId`.
6. Android se `android:register-fcm` bhejo; RTDB `fcmTokens/{uid}/{deviceId}` verify karo.
7. Web se `event:send` bhejo; ACK me `eventId` aur `ACCEPTED` verify karo.
8. Android par `event:deliver` receive karke turant `RECEIVED` bhejo.
9. Web par `SENT_WS` -> `RECEIVED` -> `PROCESSING` -> `COMPLETED` order verify karo.
10. Android app band karo / socket disconnect karo; Web se naya event bhejo.
11. FCM attempt immediately hona chahiye; status `FCM_ATTEMPTED` -> `FCM_ACCEPTED` verify karo.
12. Android FCM receive karke reconnect kare; `RECEIVED` report kare. Backend use accept kare.
13. FCM device ko event na mile to post-FCM timeout par `DELIVERY_UNCONFIRMED` verify karo.
14. Web socket disconnect karke Android se status bhejo; Web reconnect par koi replay na mile.
15. RTDB me `presence` aur `fcmTokens` ke alawa koi event path na dikhe.
16. Server logs check karo: payload, FCM token, private key redacted hone chahiye.

---

## 13. Known limitations

- **No server-side authentication or authorization.** UID aur device id client-supplied hain. Koi caller doosra UID claim kar sakta hai aur presence watch kar sakta hai. Backend Firebase ID token verify nahi karta (explicit requirement).
- **In-memory event state.** Node.js restart ya crash par in-flight events, timers aur ACK state lost. RTDB se reconstruct ya retry nahi hota.
- **No replay.** Origin Web socket disconnect hone par status updates drop ho jate hain. Reconnect par purane updates nahi milte.
- **Best-effort delivery, not exactly-once.** Late ACK + FCM race duplicate delivery de sakta hai. `eventId` based client-side dedupe best-effort hai aur Android process restart ke baad survive nahi karta.
- **No automatic retries.** FCM failure par sirf `DISCARDED`; application-level retry ya scheduled retry nahi hai.
- **No persistent queue.** Event delivery ke liye koi BullMQ/Kafka/Redis/SQL/Firestore use nahi hota.
- **Single instance.** Presence and in-flight metadata process-local hain. Multi-instance ke liye section 11 ke changes chahiye.
- **FCM is not a receipt.** `FCM_ACCEPTED` ka matlab sirf FCM API acceptance hai. Device/application receipt separate outcome hai.
- **Presence is observational in RTDB.** Authoritative online state current process ke live Socket.IO connections hain. Stale RTDB `online` entries freshness threshold ke baad trustworthy nahi.
- **Event type and payload are validated but business meaning is client-defined.** Backend schema validation generic hai; domain-specific schema app layer me add karo.
- **Single-process rate limits.** Limits per socket per process hain; multi-instance me shared limiter chahiye.
- **No service account in repo.** Setup ke waqt apne Firebase credentials provide karne honge.
