# Firebase RTDB rules for the hybrid backend

`database.rules.json` in this folder is an **additive example** for the two
paths owned by this service:

- `presence/{uid}/devices/{deviceId}`
- `fcmTokens/{uid}/{deviceId}`

Do **not** replace your production rules with this file if your Firebase
project already stores unrelated application data. Merge only these keys into
the existing rules tree.

Rules are cascading: a broad `.read` or `.write` on a parent (for example at
the database root) also grants access to these children. Review the merged tree
before deploying.

Notes:

- The backend uses the Firebase Admin SDK. Admin SDK access **bypasses client
  security rules**, so `".write": false` does not stop the backend.
- `presence` is readable only by the matching authenticated user. If the Web
  client reads presence exclusively through the backend `presence:watch`
  event, you can set this to `false` as well.
- `fcmTokens` must never be readable or writable by clients. Tokens are only
  written by the backend from `android:register-fcm`.
- No event, event history, ACK, or delivery queue paths exist. Do not add
  client-writable paths for them.
