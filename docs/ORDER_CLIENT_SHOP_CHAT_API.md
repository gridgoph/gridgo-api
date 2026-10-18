# Masked client–shop order conversation

API part of gridgo-client#246 / report 4E2F86FA. Apply forward migration `1792232100000_client_shop_chat` before deploying. Client, shop and dashboard interfaces are separate releases. This extends the existing order-chat/file/notification plumbing; the client–rider and shop–rider chats keep their contracts.

## Access and lifecycle

Every route requires a verified Clerk session and a database membership. Send `X-GRIDGO-Role` when an identity has several memberships. The owning client, currently assigned approved shop, Operations and Super Admin may read. Riders, unrelated users and other shops may not. Supplier access also respects the existing Operations artwork-release gate.

There is one conversation per order, materialized on its first message. It opens when the current shop accepts (`shopAcceptance.status = accepted` for that supplier). Older orders without an acceptance snapshot use their accepted/payment-authorized/production-or-later state. It remains open through delivery and the order's snapshotted `issueWindowExpiresAt`, then becomes **read_only**. Completion, cancellation or a pending shop recovery also stops new messages. Staff posts use the same window. Before acceptance the status is `unavailable`; reads return an empty/history projection and sends return `409 client_shop_chat_not_available`.

Messages, reports and sent attachments remain with the order as dispute evidence after closing; there is no rider-chat 24-hour purge. Attachment retention and early deletion preserve sent conversation evidence. Unsent uploads use ordinary unused-upload retention. No route edits or deletes messages. The new message foreign keys do not cascade on user deletion, preventing accidental removal of evidence.

On approved replacement, the new shop sees only messages and attachments sent for its own assignment. The former shop loses order-chat access. The client and staff retain the complete history. The thread and sender attempt counts remain attached to the same order. Historical multi-shop aggregate orders without one assigned supplier do not open this pair; independent basket groups each have an order and conversation.

Participant labels are exactly **Client**, **Print shop**, **GRIDGO**. Message/thread/file projections do not include participant names, user IDs, email addresses, telephone numbers, internal object keys or raw file references. `mine` identifies the caller's own messages. Operations and Super Admin see the private original text as evidence; clients and shops receive only masked text, including the sender's POST response.

## Routes

| Method | Route | Result |
| --- | --- | --- |
| GET | `/orders/:id/client-shop-chat` | `{chat,messages,nextAfter}`; staff also receive `reports` |
| POST | `/orders/:id/client-shop-chat/messages` | `201 {chat,message,warning?}` |
| POST | `/orders/:id/client-shop-chat/messages/:messageId/reports` | `200 {ok:true}`; works after closure |
| GET | `/ops/client-shop-chats` | Staff only: `{threads,nextOffset}` |

Messages page forward in stable `(createdAt,id)` order. `limit` defaults to 50, maximum 100; `after` is the last returned message UUID. `nextAfter` is null at the end. Invalid/inaccessible cursors return `400 invalid_chat_cursor`. GET marks only returned messages read within the domain transaction; `chat.unread` is the count before that read. The order's role-aware projection includes a lightweight `clientShopChat` affordance (window, participant labels and reminder); read the conversation for counts.

The staff list includes all conversations with messages, newest activity first. It accepts `limit` (1–100), `offset` (default 0), and `flagged=1`. `nextOffset` is null at the end. Each entry contains `orderId`, creation/activity timestamps, the normal chat fields, `flaggedAt`, `reportCount`, `contactAttempts` (thread total) and `contactThreshold`. Open a thread through the same order endpoint to read or post as GRIDGO. Staff-only message fields are `originalBody` and `contactAttempt`. Staff-only reports contain `{id,messageId,reporterLabel,reason,createdAt}`, with no reporter user ID. Flags and reports remain durable evidence; no dismissal endpoint is introduced in this release.

Send body:

```json
{"body":"Please print 100 copies, 8.5 x 11 inches.","attachmentFileIds":[]}
```

Body uses the existing chat parser: trimmed text, maximum 1,000 UTF-16 code units, or empty with an attachment. At most four distinct attachment IDs. Only ready, owned, unused uploads of the dedicated purpose can be sent. Wrong/unstripped attachments return `400 invalid_chat_attachment`; reuse returns `409 file_already_attached`. POSTs are rate limited to 30 per sender per API process in ten minutes (including reports); excess returns `429 too_many_requests`. Closed sends return `409 client_shop_chat_read_only`; methods outside the contract return 405. Normal authorization errors are 401/403, unknown orders/messages 404. Errors use `{error:"snake_case"}`.

The server does not interpret chat as an agreement or alter prices, quantities, specifications, deadlines, payment, payout or order state. Render `chat.reminder` beside the composer and route actual amendments through [formal order change requests](ORDER_CHANGES_API.md), `POST /orders/:id/change-requests`; production deadline requests also retain their [existing contract](ORDER_RESCHEDULE_API.md).

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

Before any image bytes are sent to MinIO, the existing production ImageMagick/prlimit toolchain decodes an allowlisted image coder, applies orientation, takes the first frame, bounds the longest side to 4,096 pixels, removes profiles/comments/EXIF/GPS/device data, and writes a fresh PNG without ancillary metadata. The source is never uploaded; temporary copies are removed. Rendering has CPU/memory/output/time limits, delegates disabled, and fails closed with `422 chat_image_sanitization_failed`. A renderer outage must never fall back to original bytes. No new runtime dependency is required; Docker and CI already install ImageMagick and util-linux for colour analysis. Tests exercise real image reencoding, injected EXIF/XMP, comments and the HTTP-to-object-storage path.

Images are stored/projected as `image.png`, PDFs as `document.pdf`; original filenames are not persisted for this purpose. PDFs retain their bytes. No OCR, text extraction or inspection of visible contact text in images/PDFs is included. This release strips image metadata, not arbitrary contact content embedded in documents or pixels.

Use authenticated `GET /files/:fileId` and `/files/:fileId/download-url` for metadata and short-lived signed downloads. Before sending, only the uploader reads. After sending, the owning client, corresponding current shop and staff read; no rider access. File projections omit owner IDs and references for every role. Signed URLs use the existing private MinIO bucket and neutral object paths. Sent evidence cannot be deleted through the early-deletion endpoint.

## Realtime, inbox and push

Messages, reports, file references, flags, audit rows and notifications commit in the same transaction under the existing domain advisory lock. `save()` is the sole enqueue boundary. Messages create generic counterpart notices (`client_shop_chat_message`) and staff activity notices (`client_shop_chat_activity`). Reports and first flags create `client_shop_chat_reported` / `client_shop_chat_flagged`. Party notices coalesce unread activity in a five-minute burst, as existing order chats do. No notification or push includes message text, original text, report content, filenames or contact details. Push data remains the existing allowlist (`notificationId,type,orderId,at`).

Clients receive an `orders` invalidate, the current shop a `jobs` invalidate, and staff a staff-scoped `chat` invalidate. Refetch the thread/list on the existing notification SSE stream; there is no new streaming subsystem. Delivery occurs after commit through the normal durable inbox/outbox. A staff notice failure rolls back the message and thread creation.

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
