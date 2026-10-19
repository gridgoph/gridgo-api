# Express listings

[Scheduling release 1](SCHEDULING_API.md) replaces the original Express
availability override. Express now respects production, queue, capacity,
shop/GRIDGO hours, closures and dispatch cutoff. The listing switch remains
available until the separate release-2 shop editor/conversion task.

## The shop's switch

`supplier_catalog_items.express boolean NOT NULL DEFAULT false`. Every existing
listing starts with it off.

| Route | Field |
| --- | --- |
| `POST /me/catalog-items` | Optional `express` boolean, default `false`. |
| `PATCH /me/catalog-items/:id` | Optional `express` boolean, with `expectedVersion` (or `If-Match`) like every listing edit. Omitted or `null` leaves it unchanged. A non-boolean is `400 invalid_catalog_item` with `field: "express"`; a stale version is `409 catalog_item_stale`. |

The change applies at once and **does not enter listing review**, the same as
turnaround and active/hidden changes: The switch is retained as listing metadata; scheduling no longer treats it as a promise override. An approved listing with a
review-sensitive revision pending still uses the shop's current Express switch
on the approved version clients see. A change of the switch writes the
`catalog_item.update` audit with `detail: { express }`.

## Compatibility and historical promises

Existing public and supplier listings still expose `express`. Match/cart
`expressPromise` is false for all new projections; the shared ready-by rule
supplies their timestamps. Calendar `expressAvailable` reports whether an
eligible listing retains the switch, not whether today is reachable.

Existing `order.express` and its stored `readyBy`/`promiseBy` remain immutable.
Previously placed Express orders are warning-only during the scheduling pilot,
including pending unapplied lapses. No new fee is added. See [Scheduling](SCHEDULING_API.md)
for per-date states, ready times, tier selection, role-safe order projections
and Super Admin settings.
