# Order tracking API

Live tracker for every order, Express or not (report 83C6494A). Pickup PIN and
hand-over rules are in [EXPRESS_API.md](EXPRESS_API.md#on-my-way-and-pickup-pin).
The PIN hand-over has one contract with accept-first Express: the shop sends the
PIN as `code`, plus `cashReceived: true` when the client chose cash at pickup;
payment confirmation and the shop's fee debt are recorded as in
[accept-first pickup](EXPRESS_API.md#accept-first-express-send-accept-then-pay).

## Tracker

`GET /orders`, `GET /orders/:id` and `GET /jobs` add `order.tracker` for the owning
client, the assigned shop (owner and Staff) and Operations/Super Admin. Riders and
anyone else get no tracker. Orders with no shop yet omit it.

```json
{
  "version": 1,
  "status": "printing",
  "readyBy": "2026-11-27T07:30:00.000Z",
  "readyBySource": "progress",
  "steps": [
    { "key": "sent", "status": "done", "at": "2026-11-27T06:40:00.000Z" },
    { "key": "accepted", "status": "done", "at": "2026-11-27T06:41:00.000Z", "byFirstName": "Tomas" },
    { "key": "printing", "status": "current", "at": "2026-11-27T06:50:00.000Z", "byFirstName": "Tomas",
      "progress": { "done": 60, "total": 100, "unit": "pages", "updatedAt": "2026-11-27T07:02:00.000Z" } },
    { "key": "ready", "status": "upcoming", "at": null, "expectedAt": "2026-11-27T07:30:00.000Z" },
    { "key": "picked_up", "status": "upcoming", "at": null }
  ],
  "notifiesEveryStep": true,
  "pickup": { "handover": "on_my_way_pin", "onMyWayAvailable": false, "onMyWayAt": null, "walkMinutes": null },
  "quickMessages": [],
  "ratingDue": false
}
```

- `status` is the current step key, or `cancelled`. Each step is `done`,
  `current`, `upcoming` or (cancelled orders) `cancelled`.
- The last step is `picked_up` for pickup orders and `delivered` for delivery.
  Delivery and hub details stay on their existing fields (`deliveryMilestones`,
  rider location); a delivery stays on `ready` until it is handed over.
- `sent` is when the current shop received the order (after an Express move, the
  move). `accepted` and `printing` carry the first name of the person who did
  it: the Staff member when Staff acted, otherwise the account holder.
- `readyBy` is the client's promised time (`promiseBy`); the shop sees its own
  `readyBy`. While printing with a reported count, it becomes the pace estimate
  (`readyBySource: "progress"`), never earlier than now.
- `pickup` exists for Express pickup orders: which hand-over the order uses
  (`on_my_way_pin` or `counter_code`), whether this client may tap I'm on my way
  now, and the walk estimate once tapped. After pickup, `expressOrder.handedOver`
  says when and whether cash was received at the counter (`cashReceived`).
- `notifiesEveryStep` is always true. Each step already writes a party inbox
  row that pushes (accepted, printing, ready, picked up or delivered), so the app
  can say "You don't need to keep this open." Express pickup uses its own copy:
  "Printing has started", "Your print is ready!" (version 2 adds "Tap I'm on my
  way when you leave. Your 6-digit pickup PIN shows then."), "Picked up".
  Progress counts never push. Realtime `orders`/`jobs` invalidations refresh the
  screen.

## Printing progress

`POST /orders/:id/production-progress` (assigned shop owner or Staff) while the
order is `production`:

```json
{ "done": 60, "total": 100, "unit": "pages" }
```

`done` and `total` are whole numbers, `0 <= done <= total`, `1 <= total <=
10000000`. `unit` is optional: `pages`, `copies` or `pieces` (default `pages` for
Express, `pieces` otherwise). Other bodies are `400 invalid_production_progress`;
other states are `409 production_progress_unavailable`. The response is
`{orderId, tracker}`. The raw count is stored as `productionCount` and is only
visible through the tracker; each write is audited.

## Quick messages

Fixed one-tap messages for Express pickup, sent through the existing order chat
so masking, reports, notifications and history are unchanged:

`POST /orders/:id/client-shop-chat/messages` with
`{ "quickMessage": { "code": "keep_until", "time": "17:00" } }` and no `body` or
`attachmentFileIds`. `tracker.quickMessages` lists what the viewer may send now:

| Party | Stage | Codes and text |
| --- | --- | --- |
| Client | ready, before I'm on my way | `there_in_10` "I'll be there in 10 mins", `keep_until` "Please keep it until 5 PM" (`time` is local `HH:MM`, `needsTime: true`) |
| Client | after I'm on my way | `im_here` "I'm here · Ania na ko", `running_late` "Running late", `thank_you` "Thank you!" |
| Shop | ready | `ready_at_counter` "Your print is ready at the counter.", `see_you_soon` "See you soon!" |
| Either | after pickup | `thank_you` "Thank you!" |

A code that does not fit the stage is `409 quick_message_unavailable`; a
malformed one is `400 invalid_quick_message`. Delivery orders have none.

## Rating after pickup

Express orders may be rated (`POST /orders/:id/review`) as soon as they are
picked up or delivered (`issue_window_open`); the `order_rate_reminder` push is
sent then too, and `tracker.ratingDue` is true until rated. Other orders keep
the existing rule: after the issue window closes. The app may skip the prompt.
