# Masked client–shop order conversation

API part of gridgo-client#246 / report 4E2F86FA. Apply forward migration `1792232100000_client_shop_chat` before deploying. Client, shop and dashboard interfaces are separate releases. This extends the existing order-chat/file/notification plumbing; the client–rider and shop–rider chats keep their contracts.

## Access and lifecycle

Every route requires a verified Clerk session and a database membership. Send `X-GRIDGO-Role` when an identity has several memberships. The owning client, currently assigned eligible shop, Operations and Super Admin may read. Riders, unrelated users and other shops may not. Supplier access also respects the existing Operations artwork-release gate.

There is one conversation per order, materialized on its first message or an Express system event. For regular orders, it opens when the current shop accepts (`shopAcceptance.status = accepted` for that supplier). Older orders without an acceptance snapshot use their accepted/payment-authorized/production-or-later state. It remains open through delivery and the order's snapshotted `issueWindowExpiresAt`, then becomes **read_only**. Completion, cancellation or a pending shop recovery also stops new messages. Staff posts use the same window. Before acceptance the status is `unavailable`; reads return an empty/history projection and sends return `409 client_shop_chat_not_available`.

Messages, reports and sent attachments remain with the order as dispute evidence after closing; there is no rider-chat 24-hour purge. Attachment retention and early deletion preserve sent conversation evidence. Unsent uploads use ordinary unused-upload retention. No route edits or deletes messages. The new message foreign keys do not cascade on user deletion, preventing accidental removal of evidence.

On approved replacement, the new shop sees only messages and attachments sent for its own assignment. The former shop loses order-chat access. The client and staff retain the complete history. The thread and sender attempt counts remain attached to the same order. Historical multi-shop aggregate orders without one assigned supplier do not open this pair; independent basket groups each have an order and conversation.

On regular orders, participant labels are exactly **Client**, **Print shop**, **GRIDGO**. Message/thread/file projections do not include participant names, user IDs, email addresses, telephone numbers, internal object keys or raw file references. `mine` identifies the caller's own messages. Operations and Super Admin see the private original text as evidence; clients and shops receive only masked text, including the sender's POST response.

## Routes

| Method | Route | Result |
| --- | --- | --- |
| GET | `/orders/:id/client-shop-chat` | `{chat,messages,nextAfter}`; staff also receive `reports` |
| POST | `/orders/:id/client-shop-chat/messages` | `201 {chat,message,warning?}` |
| POST | `/orders/:id/client-shop-chat/messages/:messageId/reports` | `200 {ok:true}`; works after closure |
| GET | `/ops/client-shop-chats` | Staff only: `{threads,nextOffset}` |

Messages page forward in stable insertion order, including replies with identical timestamps. `limit` defaults to 50, maximum 100; `after` is the last returned message UUID. `nextAfter` is null at the end. Invalid/inaccessible cursors return `400 invalid_chat_cursor`. GET marks only returned messages read within the domain transaction; `chat.unread` is the count before that read. The order's role-aware projection includes a lightweight `clientShopChat` affordance (window, participant labels and reminder); read the conversation for counts.

The staff list includes all conversations with messages, newest activity first. It accepts `limit` (1–100), `offset` (default 0), and `flagged=1`. `nextOffset` is null at the end. Each entry contains `orderId`, creation/activity timestamps, the normal chat fields, `flaggedAt`, `reportCount`, `contactAttempts` (thread total) and `contactThreshold`. Open a thread through the same order endpoint to read or post as GRIDGO. Staff-only message fields are `originalBody` and `contactAttempt`. Staff-only reports contain `{id,messageId,reporterLabel,reason,createdAt}`, with no reporter user ID. Flags and reports remain durable evidence; no dismissal endpoint is introduced in this release.

Send body:

```json
{"body":"Please print 100 copies, 8.5 x 11 inches.","attachmentFileIds":[]}
```

Body uses the existing chat parser: trimmed text, maximum 1,000 UTF-16 code units, or empty with an attachment. At most four distinct attachment IDs. Only ready, owned, unused uploads of the dedicated purpose can be sent. Wrong/unstripped attachments return `400 invalid_chat_attachment`; reuse returns `409 file_already_attached`. Message/report POSTs are rate limited to 30 per sender per API process in ten minutes (including reports); excess returns `429 too_many_requests`. Closed sends return `409 client_shop_chat_read_only`; methods outside the contract return 405. Normal authorization errors are 401/403, unknown orders/messages 404. Errors use `{error:"snake_case"}`.

Outside the explicit pre-acceptance Express extras endpoint below, the server does not interpret chat as an agreement or alter prices, quantities, specifications, deadlines, payment, payout or order state. Render `chat.reminder` beside the composer and route actual amendments through [formal order change requests](ORDER_CHANGES_API.md), `POST /orders/:id/change-requests`; production deadline requests also retain their [existing contract](ORDER_RESCHEDULE_API.md).

## Masking and repeated attempts

Masking runs before insert, on the server. The original trimmed body and masked body are stored separately in PostgreSQL; only staff evidence reads select the original into a response. Recognized contacts become `[contact hidden]`: PH mobile/landline numbers (including +63, 09, spaces, parentheses, hyphens and dots), international numbers with `+`, email addresses, `at`/`dot` obfuscations, `@handles`, common platform-prefixed handles, domains and URLs. URL, domain and handle masking consumes the entire token, including paths, queries and fragments; no trailing profile handle is retained. Compatibility characters and invisible separators are normalized before detection. Normal sizes, short quantities, decimal prices and dates are covered by negative tests. This is a deterministic recognizable-contact filter, not semantic moderation of every possible disguise. Existing stored messages are not rewritten.

One message containing one or more recognized contacts counts as **one attempt**, per sender per order. `chat.contactAttempts` is the caller's count on party responses. Super Admin may set `clientShopChatContactThreshold` through the existing audited/versioned `PATCH /settings` (`expectedVersion`, `reason` required): integer 1–20, default **3** for existing and new settings. A threshold change is evaluated on the sender's next contact attempt; it does not rewrite historical messages or backfill notices. At/above threshold, the response includes a fixed `warning`, the thread is flagged, and the first flag writes a durable staff inbox notice to **each current Operations and Super Admin membership**. The warning remains visible on subsequent reads/sends while that sender is over the current threshold. One sender's attempts do not advance another's warning count.

Every message has a report action, including GRIDGO messages. Body:

```json
{"reason":"contact_sharing"}
```

Reasons: `contact_sharing | inappropriate | change_request | other`. Missing/invalid reason returns `400 invalid_chat_report_reason`. One report per reporter/message; retry is idempotent and preserves its first reason. Reports flag the thread immediately and create staff notices exactly once per report. Reports do not change order terms or reopen the writing window. A shop cannot report or probe an inaccessible prior-assignment message.

## Attachments and image privacy

Upload using the existing multipart `POST /files`, `purpose=client_shop_chat_attachment`, then send the returned file ID. Accepted inputs: **JPEG, PNG, WebP and PDF only; 10 MiB per file**. Existing extension/MIME/magic-byte checks apply. Other formats return 415; oversize returns 413. Upload authorization is client, approved supplier, Operations or Super Admin. Generic `/files/:id/attach` is refused (`409 client_shop_chat_attachment_not_attachable`); sending the message binds the file atomically.

Before any image bytes are sent to MinIO, the existing production ImageMagick/prlimit toolchain decodes an allowlisted image coder, applies orientation, takes the first frame, bounds the longest side to 4,096 pixels, removes profiles/comments/EXIF/GPS/device data, and writes a fresh PNG without ancillary metadata. The source is never uploaded; temporary copies are removed. Rendering has CPU/memory/output/time limits, delegates disabled, and fails closed with `422 chat_image_sanitization_failed`. A renderer outage must never fall back to original bytes. Docker and CI also install the bounded QR/OCR scanners described below. Tests exercise real image reencoding, injected EXIF/XMP, comments and the HTTP-to-object-storage path.

Images are stored/projected as `image.png`, PDFs as `document.pdf`; original filenames are not persisted for this purpose. PDFs retain their bytes. Regular conversations retain their existing attachment contract. Express additionally uses the server scan described below.

Use authenticated `GET /files/:fileId` and `/files/:fileId/download-url` for metadata and short-lived signed downloads. Before sending, only the uploader reads. After sending, the owning client, corresponding current shop and staff read; no rider access. File projections omit owner IDs and references for every role. Signed URLs use the existing private MinIO bucket and neutral object paths. Sent evidence cannot be deleted through the early-deletion endpoint.

## Realtime, inbox and push

Messages, reports, file references, flags, audit rows and notifications commit in the same transaction under the existing domain advisory lock. `save()` is the sole enqueue boundary. Messages create generic counterpart notices (`client_shop_chat_message`) and staff activity notices (`client_shop_chat_activity`). Reports and first flags create `client_shop_chat_reported` / `client_shop_chat_flagged`. Party notices coalesce unread activity in a five-minute burst, as existing order chats do. No notification or push includes message text, original text, report content, filenames or contact details. Push data remains the existing allowlist (`notificationId,type,orderId,at`).

Clients receive an `orders` invalidate, the current shop a `jobs` invalidate, and staff a staff-scoped `chat` invalidate. Refetch the thread/list on the existing notification SSE stream; there is no new streaming subsystem. Delivery occurs after commit through the normal durable inbox/outbox. A staff notice failure rolls back the message and thread creation.


## Express order chat and shared shop inbox

Report **2F969819**, API tracker gridgoph/gridgo-api#452. Apply forward migrations
`1795802000000_express_order_chat`, `1795802001000_chat_message_positions` and
`1795802002000_express_chat_extras` before deploying this API.

Express opens only after Send: the persisted `expressOrder.events` includes
`sending` or `sent` and the order has an assigned shop. There is no chat route
from a shop card or draft. Cancellation makes the conversation read only.
Pickup closes writing after `orderChatCloseAfterPickupHours` (default **24**,
integer 1–168). Pickup includes the client's counter collection or the rider's
recorded pickup. Completion and the issue-window deadline do not shorten this
Express window. History and dispute evidence remain readable after closure.
Super Admin alone changes the lifetime via versioned/audited `PATCH /settings`
with `expectedVersion` and `reason`; a change applies to existing Express chats.
Regular order windows above are unchanged.

Express `chat.note` is fixed:

> Keep the chat about the job. Call the shop with the call button.

`chat.quickReplies` exposes `{code,text}` choices. Client codes `staple`,
`colour_cover`, `is_ready` have text “Can you staple it?”, “Colour cover only”,
“Is it ready?”. Shop codes `ready_now`, `printing_now`, `almost_done` have text
“Ready na po”, “Printing na”, “Gamay nalang”. Existing pickup replies remain
available at their applicable stages. Send `{quickMessage:{code}}` through the
ordinary messages endpoint, without a typed body or attachments.

Express masking uses `[number hidden]` for recognized phone/contact details,
labelled e-wallet/account numbers and payment QR payloads. Before a home printer
accepts, known pickup descriptions and recognized address phrases are also
masked. Order quantities, dimensions, amounts and readiness times remain intact;
artwork, structured production specs, payment evidence and the governed pickup
point use their existing private routes. Masking is deterministic and cannot
recognize every possible coded phrase or handwriting.

Chat uploads are scanned before the bytes reach MinIO. QR detection uses ZBar;
visible text uses Tesseract and the same contact/address rules. PDFs are rendered
with Poppler (at most four pages); image scanning uses sanitized pixels. Each
subprocess has memory, CPU, output and wall-time limits and one OCR thread.
Only boolean verdicts are persisted, never extracted private text. Express
withholds an attachment containing a recognized payment/contact QR payload or
contact text, or an address before home
acceptance. Missing/failed scans and older unscanned uploads also fail closed.
The message returns `hiddenAttachments:[{marker:"number hidden"}]`, with no file
ID or download reference. Hidden files remain staff-only dispute evidence; the
counterpart cannot fetch them through metadata, preview or signed-download
routes. Safe attachments and ordinary production artwork remain available.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/me/shop-chats?filter=all` | Shared selected-shop inbox; `all`, `needs_reply`, `mine` |
| POST | `/orders/:id/client-shop-chat/typing` | `{typing:true}` renews an 8-second indicator; `false` clears it |
| PATCH | `/orders/:id/express/extras` | Versioned replacement of agreed extras before acceptance |
| POST | `/orders/:id/client-shop-chat/calls` | Reserved; authorized open chat returns `503 calling_service_not_configured` |

Owner, active managers and active staff all use the same selected-shop context
(`X-GRIDGO-Role: supplier`, `X-GRIDGO-Shop-Id` when needed). Pending, removed and
unrelated members cannot read or reply. The existing locked-device/PIN worker
context remains supported, including separate worker attribution. Chat access
never grants Money or settlement access.

The inbox returns `{threads,unreadCount,nextOffset}`. Pagination uses `limit`
(default 50, maximum 100), `offset` (default 0). Each row contains `orderId`,
`orderNumber`, order `status`, `clientFirstName`, `lastMessage`, `updatedAt`,
per-person `unread`, `needsReply`, `unansweredSince`, `owner:{firstName,mine}` and
`followedUpBy:[{firstName}]`; `chat` contains the writing window. Needs reply
means a client message has no later human shop reply; reading or a system line
does not answer it. `mine` filters by the accepting worker, not the last replier.
Sending a human reply marks preceding messages read for that signed-in person.

Each Express shop message snapshots `senderFirstName`, `senderShop` and optional
`senderPhotoFileId`; `senderLabel` is “first name · shop”. Full personal names,
phone numbers and worker/account IDs are omitted. System messages include
`systemEvent: accepted | ready` and name the actor. Acceptance assigns the chat
owner atomically; any active teammate can follow up without taking ownership.
Each lifecycle system event is written once per shop/order. Thread reads expose
`chat.typing:[{firstName,role,expiresAt}]`; replies clear the sender's indicator.
Indicators expire without a lifecycle job, have no push, and use a separate
60-per-minute rate limit. Apps refetch on the existing `orders`/`jobs` SSE
invalidates; staff retain the existing `chat` invalidate. Client messages send
generic durable notices to every active shop member, regardless of job-alert
preferences, plus the existing Operations and Super Admin activity notices.

### Agreed shop extras

This applies to independent accept-first Express requests (`acceptFlow:2`),
while the assigned shop's acceptance is pending and its countdown has not
expired. Existing paid, basket and group orders keep their own change contracts.
The shop attests that the client agreed to the named quantity and price in chat,
and supplies the client's message as durable evidence:

```json
{
  "expectedVersion": 0,
  "items": [{
    "label": "Staple by set", "quantity": 3, "unitPriceMinor": 100,
    "agreedMessageId": "0653bca4-672c-4db4-b9d2-3d056bf35e80"
  }]
}
```

`expectedVersion` starts at zero and increases on each edit; an empty list
removes proposed extras. At most 20 items, labels 1–80 characters, quantities
1–10,000, positive safe-integer PHP minor-unit prices. Evidence must be a
non-contact-sharing client text message in this order and current shop's
conversation. A message reference records the shop's attestation; the API does
not infer semantic consent from natural language. Stale edits return
`409 express_extras_stale`; missing evidence returns
`409 express_extra_agreement_required`; late or accepted edits return
`409 express_extras_not_pending`. Home-printer total caps remain enforced.
If total rounding would leave a locked promotion larger than the remaining fee,
`409 express_extra_discount_requote_required` requires a fresh quote instead of
changing the promotion funding. If
rounding would make an already reserved fee-funded discount exceed the new fee,
`409 express_extra_discount_requote_required` preserves its funding and requires
a fresh client quote. If
rounding would leave a locked promotion without its original funding,
`409 express_extra_discount_requote_required` asks for a fresh request instead of
creating negative payment allocations.

The edit returns `shopExtras` with the proposed printing/extras/total, version
and `{label,quantity,unitPriceMinor,amountMinor,addedBy:"shop",marker:"added by shop"}`
items. Shop job projections retain that bounded quote for recovery after refresh.
Each extras edit writes durable notices to both Operations and Super Admin.
Accept commits the extras, payment allocations, supplier payout base and invoice
in one transaction. Original print lines and the original fee schedule remain
intact. The same `serviceFeeMoney` code used by accept-first prices printing plus
extras, preserving discounts and voucher funding. Example: printing PHP 108 +
extras PHP 3 + fee PHP 22.50 = **PHP 133.50**. The client sees the separate printing,
extras and GRIDGO fee before choosing payment. Retries cannot add the extras
twice; accepted extras and accepted totals are guarded in PostgreSQL. Later
amendments require the normal formal change flow.

### Calling integration boundary

No calling provider is configured or charged by this release. Express chat
returns `calling:{available:false,reason:"calling_service_not_configured"}`.
Companion apps must disable the call action. A later provider integration belongs
behind this capability and the same order-party/window authorization, with
short-lived, opaque participant credentials; never return personal numbers or
fall back to a telephone link. Provider options and approximate costs are in the
implementation pull request for a separate decision. The reserved POST calls
route checks the same participants and open window and returns no media token;
closed chats return 409. Existing rider call pairs keep their current contract.

## Before and after examples

Before this release, `GET /orders/order_123/client-shop-chat` returns `404 {"error":"not_found"}`. A submitted message can now contain:

```json
{"body":"Call 0917.123.4567 or hello at example dot com"}
```

The sender and shop receive only:

```json
{
  "chat": {
    "status": "open",
    "closesAt": null,
    "participants": ["Client", "Print shop", "GRIDGO"],
    "reminder": "Price, specification and deadline changes require a formal change request. Chat messages do not change the order.",
    "unread": 0,
    "contactAttempts": 1
  },
  "message": {
    "id": "ca5961d1-0d31-42f4-a7ef-858ba4760e81",
    "senderLabel": "Client",
    "body": "Call [contact hidden] or [contact hidden]",
    "mine": true,
    "createdAt": "2026-10-17T12:00:00.000Z",
    "attachments": []
  }
}
```

The shop's GET has the same masked body, `mine:false`, its own attempt count and unread count. A shop reply has `senderLabel:"Print shop"`; a staff reply has `senderLabel:"GRIDGO"`. Staff evidence reads add the original body and `contactAttempt:true`; those properties never appear in party responses.
