# Private order voice calls

Report **16B159C0**, [client issue 233](https://github.com/gridgoph/gridgo-client/issues/233).
The 8 Oct 2026 decision is in-app internet audio over mobile data/Wi-Fi. The API
provides authorization, call state, private signalling, notifications and optional
coturn credentials. Media travels through WebRTC, directly or via TURN; GRIDGO
never records audio. No telephone provider, phone dialler or per-minute calling
charge is involved. Operator bandwidth still applies.

## Parties and windows

Every route requires a Clerk session and the app's selected database membership
(`X-Gridgo-Role: client | rider | supplier` for multi-role identities).

| `pair` | Participants | Calling window |
| --- | --- | --- |
| `delivery` | Owning client ↔ currently assigned, approved rider | Door delivery (`fulfillmentMode != pickup`), `rider_assigned`, `picked_up`, `out_for_delivery`; exactly the writable delivery-chat window |
| `pickup` | Assigned, approved shop ↔ currently assigned, approved rider | `rider_assigned` only, including trips to GRIDGO Office; ends when pickup is done |

The pickup parties and artwork release gates come from `pickupChatParty`; its
chat window is intentionally longer than the calling window. No client/shop,
client/client, rider/rider, Operations or Super Admin calls. No caller-selected
user IDs. Another order's call ID cannot be used. Reassignment, role/approval
revocation, account suspension and leaving the calling window end active calls.
The old rider immediately loses API access; the replacement never sees old calls.

There is one active (`ringing` or `accepted`) call per order and pair, protected
by the domain transaction lock and a database unique index. The two pairs are
independent; apps should decline a second incoming call when already speaking.
Each caller may start at most ten calls in ten minutes (database checked).

## Lifecycle routes

Base: `/orders/:orderId/calls`. All responses are `Cache-Control: no-store`.

| Method/path | Body | Result |
| --- | --- | --- |
| `POST /calls` | `{ "pair": "delivery" }` or `pickup` | `201 { call }`, starts ringing and notifies callee |
| `GET /calls` | — | `{ calls }`, up to 100 retained calls for this party/current assignment, active first then newest |
| `GET /calls/:callId` | — | `{ call }`, current state |
| `POST /calls/:callId/accept` | `{}` | Callee only, ringing → accepted |
| `POST /calls/:callId/decline` | `{}` | Callee only, ringing → declined; missed notice to callee |
| `POST /calls/:callId/cancel` | `{}` | Caller only, ringing → cancelled; attempted-call notice to callee |
| `POST /calls/:callId/end` | `{}` | Either party, accepted → ended |
| `POST /calls/:callId/heartbeat` | `{}` | Either party renews **their own** accepted-call lease |

Action responses are `200 { call }`. A call projection is explicitly allowlisted:

```json
{
  "id": "e115b493-dee1-448f-b6ba-a9868f448df2",
  "orderId": "ord_example",
  "pair": "delivery",
  "state": "ringing",
  "caller": { "firstName": "Alex", "role": "client" },
  "callee": { "firstName": "Sam", "role": "rider" },
  "mine": true,
  "createdAt": "2026-10-08T08:00:00.000Z",
  "ringExpiresAt": "2026-10-08T08:00:30.000Z",
  "acceptedAt": null,
  "endedAt": null,
  "leaseExpiresAt": null
}
```

`mine` identifies the caller. No user IDs, full names, emails or phone numbers
are copied into call identity. Only the first name is used; names resembling
contact details fall back to Client/Rider/Shop. Unknown request fields are never
copied into responses.

Ringing expires at exactly `ringExpiresAt` (30 seconds). Every call request
reconciles it; a dedicated one-second server sweep handles silent phones, including
restart recovery and multiple API replicas. Under load notification delivery may
lag, but a late accept always fails. No timer is authoritative only in memory.

Both apps POST heartbeat every 20 seconds while accepted. `leaseExpiresAt` is the
earlier participant heartbeat plus 90 seconds. Calls also end after two hours.
Apps must stop audio, release the microphone and close RTCPeerConnection when
state becomes terminal, a permission/window request fails, or the lease elapses
without a successful renewal. The API cannot forcibly disconnect a direct peer
media channel: this fail-closed behavior is required in all three apps.

Transitions are serialized; the first valid accept/decline/cancel/end wins.
Terminal transitions do not duplicate notifications. After a lost response,
GET current state before retrying. A start retry returns `409 call_already_active`;
GET the list to recover the active call rather than starting another.

## Signalling and realtime

Use the existing authenticated `GET /notifications/stream` SSE connection.
`event: invalidate` with `data: {"resource":"calls","id":"ord_example"}`
means refetch that order's calls and the current call's signals. Only the two
participants are queued for these pointers. PostgreSQL NOTIFY and local delivery
happen after commit through `src/realtime-transport.js`, so they work across API
replicas. No SDP or ICE is sent in push, generic notification rows or NOTIFY.

SSE is one-way and is not a replay queue. The simplest reliable design is HTTP
POST for all outbound signals, SSE as a prompt to fetch, and the same HTTP GET as
a fallback. On reconnect/app focus refetch the order's calls. While a call screen
is active, poll state/signals every two seconds even with SSE; stop on terminal
state. This also handles a dropped pointer or permission change.

- `POST /calls/:callId/signals` submits one of the bodies below, returns
  `201 { id: <integer> }`. Retrying the same `clientId` and payload returns
  `200 { id }`; changing its payload is `409 call_signal_conflict`.
- `GET /calls/:callId/signals?after=0` returns
  `{ signals: [{id,kind,...payload}], cursor, call }`, only the other party's
  signals in sequence order. Use the returned cursor on the next fetch;
  deduplicate by signal ID. Maximum 256 signals **total** per live call.
- Only the caller may send one offer; only an accepted callee may send one answer
  after the offer. Callee ICE also waits for acceptance. Both parties may trickle
  ICE. Buffer remote ICE until `setRemoteDescription` completes.

```json
{ "clientId": "offer_1", "kind": "offer", "sdp": "v=0\r\n..." }
```

```json
{ "clientId": "answer_1", "kind": "answer", "sdp": "v=0\r\n..." }
```

```json
{
  "clientId": "ice_1", "kind": "ice",
  "candidate": "candidate:1 1 UDP 1 192.0.2.1 1234 typ host",
  "sdpMid": "0", "sdpMLineIndex": 0
}
```

`clientId` is 1–64 ASCII letters/digits/underscore/hyphen, unique per sender/call.
An empty candidate means end-of-candidates; nullable `sdpMid` and
`sdpMLineIndex` are allowed. SDP is capped at 60,000 bytes and must contain exactly
one `m=audio` section using DTLS-SRTP (`UDP/TLS/RTP/SAVPF`); video/application
sections and SDP contact/identity lines are rejected. Session labels and origin
usernames are normalized. ICE candidates are capped at 2,048 characters and line
breaks are rejected. Only the documented fields are relayed. Apps generate opaque
track/stream identifiers and never put profile/contact data into SDP/ICE.
Signalling necessarily contains WebRTC network addresses; it is private to the
call parties, never logged. These controls authorize negotiation; the API does
not inspect encrypted media.

The first version supports one offer/answer negotiation per call. If the native
peer connection fails or needs an ICE restart, end and start a new call. Signals
are stored only for the live call (including reconnect recovery), capped at 256,
and deleted on any terminal transition. No signal or audio history is retained.

Recommended app sequence: start → get ICE servers → create audio-only peer and
offer → POST offer and ICE → callee accepts → get ICE servers and offer → create
answer → POST answer and ICE → caller applies answer → both heartbeat. Never
request camera permission or add video/data tracks.

## Push and inbox

The start transaction creates `order_call_incoming` for the callee's app, using
the normal notification inbox/outbox and `src/push.js`. Android is high priority;
APNs priority is 10. Incoming pushes use zero provider storage TTL and expire at
the ringing deadline on the API; accepting/ending silences remaining outbox sends.
`order_call_missed` is created once for timeout, decline or caller cancellation,
for the callee to open the order and call back. Both types use fixed generic copy.

Push data stays `{notificationId,type,orderId,at}` only. On incoming, open the
call screen, GET the order's calls, and ring only for a still-ringing call where
`mine` is false and `ringExpiresAt` is in the future. A stale/duplicate push must
not reopen ringing. On missed, open the order. The declined caller learns the
outcome via state/SSE. Lifecycle events also create generic Operations/Super
Admin inbox rows; those grant no call or signalling access.

Ordinary notification delivery does not guarantee that iOS wakes a terminated
app or presents a native incoming-call UI. The companion apps must implement and
verify their platform lifecycle behavior on real phones; this API does not add
PushKit/CallKit tokens, native screens or a paid service. No production-readiness
claim is made until the three app releases are tested.

## ICE endpoint and configuration

`GET /orders/:orderId/calls/:callId/ice` requires a current participant and live
call/window. Response:

```json
{
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    {
      "urls": ["turn:turn.example.test:3478", "turns:turn.example.test:5349?transport=tcp"],
      "username": "1791447000:opaque_random_nonce",
      "credential": "base64_hmac",
      "credentialType": "password"
    }
  ],
  "expiresAt": "2026-10-08T10:50:00.000Z",
  "relayAvailable": true
}
```

`STUN_URLS` and `TURN_URLS` are comma-separated URLs. STUN defaults to the address
above. TURN requires both valid TURN URLs and `TURN_SHARED_SECRET`; otherwise
only STUN is returned, `relayAvailable: false`, `expiresAt: null`. STUN-only can
fail on restrictive carrier/Wi-Fi NATs; do not claim universal connectivity.
`TURN_CREDENTIAL_TTL_SECONDS` defaults to 600 and is bounded to 60–3600.

Credentials use an expiry Unix timestamp plus a random nonce as username and
Base64 HMAC-SHA1(shared secret, username), compatible with the
[coturn TURN REST scheme](https://github.com/coturn/coturn/blob/master/README.turnserver#turn-rest-api).
No identity/contact information or shared secret is returned. Fetch fresh
credentials before expiry if needed; cached credentials must not be reused for
a new call. TURN authentication expiry limits credential reuse, not immediate
revocation of existing allocations.

## Persistence, errors and rollout

Apply `1791972000000_order_calls` before starting this version. On the development
database with later-numbered migrations already applied, use
`node-pg-migrate up --no-check-order` (with this repository's migrations directory).
There is no boot-time DDL. All call writes, notifications and realtime enqueue
run in the domain-lock transaction, including timeout reconciliation on GET.

Call records are private SQL tables, not `orders.data`. The chat lifecycle sweep
removes them when the corresponding chat closes: one day after delivery/office
drop-off, or on reassignment/cancellation. The FK also deletes them with the
order. Pickup call metadata can remain through the longer pickup-chat window,
but live calling and signalling stop at pickup. Generic inbox notices outlive
call records just as chat notices do. Audio never enters API persistence/MinIO.

Errors use `{ "error": "snake_case" }`: `401 unauthorized`, `403 forbidden`,
`404 order_not_found`/`call_not_found`, `410 call_history_closed`,
`400 invalid_call_pair`/`invalid_call_signal`/`invalid_cursor`,
`409 call_not_available`/`call_already_active`/`call_not_active`/
`invalid_call_transition`/`call_signal_out_of_order`/`call_signal_conflict`,
`429 too_many_requests`/`call_signal_limit`, `405 method_not_allowed`.

The optional coturn profile and operator-only installation steps are in
[Deployment](DEPLOYMENT.md#optional-voice-relay-coturn). This API change does not
start production services or open ports. Client, rider and supplier screens,
background/native call UX, video, group calls and dashboard work are separate.
