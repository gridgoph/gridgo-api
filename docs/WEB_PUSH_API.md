# Supplier browser Web Push

Supplier web apps use standard encrypted Web Push with VAPID, independent of
Firebase and native APNs credentials. All routes require a verified Clerk bearer
and a PostgreSQL `supplier` membership. Ordinary account-standing restrictions
apply. Browser notification permission is requested by the portal in response to
an explicit user action. The portal owns its manifest, service worker and install
experience; the API does not send notifications to an unregistered browser.

## Registration contract

`GET /web-push/public-key` returns `200 { "publicKey": "<base64url P-256 public key>" }`.
Use this value as the Push API `applicationServerKey`, with `userVisibleOnly: true`.
Only the public key is returned. Missing or invalid server configuration returns
`503 { "error": "web_push_unavailable" }`.

`POST /web-push/subscribe` accepts:

```json
{
  "subscription": {
    "endpoint": "https://web.push.apple.com/<opaque value>",
    "expirationTime": null,
    "keys": { "p256dh": "<browser public key>", "auth": "<browser auth secret>" }
  }
}
```

The subscription is the browser's `PushSubscription.toJSON()` value. The API fixes
`userId` to the authenticated identity and `appRole` to `supplier`, regardless of
request fields. Success is always `200 { "ok": true }`; endpoints and encryption
keys are never returned. The HTTP User-Agent is retained up to 512 characters.
Invalid input returns `400 invalid_web_push_subscription`.

Only HTTPS port 443 URLs without credentials or fragments are accepted, on
`web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, or
subdomains of `notify.windows.com`. This prevents callers using the delivery
worker to request arbitrary internal URLs. The transport does not follow redirects.
The `p256dh` must be a valid uncompressed P-256 point; `auth` is 16 bytes.

An endpoint is unique across users. Re-registering identical keys for the same
user refreshes the User-Agent and update time, preserving queued notifications.
A new owner or changed keys replaces the subscription id and removes its pending
work, so a shared browser cannot receive the previous account's queued events.
Re-register on authenticated portal launch and after browser subscription changes.

`POST /web-push/unsubscribe` accepts `{ "endpoint": "<subscription endpoint>" }`.
It deletes only the caller's registration and queued work. Success is idempotent
`200 { "ok": true }`, including for another account's or an absent endpoint.
Invalid endpoint shape returns `400 invalid_web_push_endpoint`.

Before ending the Clerk session, either unsubscribe or call existing
`POST /auth/logout` with `{ "webPushEndpoint": "<subscription endpoint>" }`.
The logout hook also supports an identity whose supplier membership was removed.
The portal should call the browser subscription's `unsubscribe()` as well.
There is no anonymous Web Push registration or device-discovery endpoint.
Unauthenticated requests return `401`; non-supplier requests return `403 forbidden`.

## Delivery and privacy

Every durable notification eligible for the supplier app also queues a row for
each eligible browser subscription in the **same** `notification_push_outbox`,
inside the notification's domain transaction. `save()` kicks its single-flight
worker after commit; the lifecycle tick remains the retry backstop. Web Push works
when FCM/APNs are disabled. A Web Push failure never fails its triggering mutation.
Native and browser destinations have independent attempts and outcomes.

The existing `deviceAcceptsNotification`, `notificationVisible`, and
`pushMessageFor` rules apply to browsers too: role/membership/order access,
`push: false`, deleted notifications, season suppression and upstream reminder
quiet windows are preserved. Delivery rechecks ownership and visibility from a
fresh snapshot per batch. Retries use the shared exponential backoff, eight-attempt
limit, five-minute lease and 48-hour outbox expiry. Each provider request has a
10-second timeout and a one-hour delivery TTL. HTTP 404/410 deletes the dead
subscription and cascades its outbox records. Other failures retain it for retry.

The encrypted JSON payload is:

```json
{
  "title": "GRIDGO update",
  "body": "Open GRIDGO for the latest update.",
  "data": {
    "notificationId": "notification_opaque_id",
    "type": "event_type",
    "orderId": "order_opaque_id",
    "at": "2026-10-16T00:00:00.000Z"
  },
  "url": "/supplier/jobs/order_opaque_id"
}
```

`data` contains only the existing allowlist; absent fields are omitted. Ordinary
private events use fixed lock-screen copy, never customer names, payment amounts,
artwork or provider response bodies. Public announcement copy follows the existing
native-push policy. `url` is `/supplier/jobs/<encoded orderId>` for order events, otherwise
`/supplier`; it is never a caller-controlled redirect. The service worker should display the notification
and focus/open this portal URL on click; authenticated portal navigation may use
the allowlisted identifiers. Always constrain click destinations to its own origin.

`web_push_subscriptions` stores private endpoints/keys and owner, role, User-Agent,
created/updated times, last success/failure times and a sanitized failure code.
It is separate from the route compatibility store, so unrelated domain saves
cannot overwrite delivery telemetry. `/health.push.webPush.status` reports
`configured` or `misconfigured`; it does not certify browser delivery. Native
`/ops/push/stats` reach aggregates remain device-token-only.

## VAPID persistence and dependency

See [deployment](DEPLOYMENT.md#supplier-browser-web-push) for environment overrides,
automatic database-backed keys, backups and rotation. Migration
`1792058200000_web_push` must run before the API; no boot-time DDL is performed.

`web-push` 3.6.7 is the additional direct runtime dependency approved for this
feature. It implements the interoperable VAPID signing and Web Push encryption
protocols ([upstream documentation](https://github.com/web-push-libs/web-push)),
avoiding custom cryptography. It is lockfile-pinned, pure JavaScript, and requires
no compiler or image changes. FCM continues using `node:crypto` and `fetch`.
