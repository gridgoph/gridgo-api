# gridgo-api

Local **custom** demo backend for all GRIDGO apps.

## MVP

- Custom auth (no Clerk)
- JSON store (no Supabase)
- Pilot Credits + COD only (no PayMongo)
- Replaceable: keep route contracts stable

See `PRD.md` and `README.md`.

## Geography (map / OSRM)

Orders carry additive map points so apps never geocode at runtime:

- `pickup: { lat, lng, label } | null` — supplier shop; **null** until a supplier is assigned
- `dropoff: { lat, lng, label }` — client delivery point; `label` matches `address`
- Keep existing `address` and `zone` strings unchanged

Supplier users may have `shop: { lat, lng, label }`. Order `pickup` is derived from that shop. Coords are real **Davao City** anchors (centre ~`7.0731, 125.6128`); zone-based dropoffs use a small deterministic offset so pins do not stack.

Rider tracking:

- `POST /dispatch/:id/location` — assigned rider pings while `picked_up` / `out_for_delivery`
- `GET /dispatch/:id/location` — latest ping (`{ ping }` or `{ ping: null }`); no staleness verdict
  - Allowed: assigned rider, order client, assigned supplier, ops/super admin
  - Else `403` `{ error: "forbidden" }`

Seed via `npm run reset` (`src/seed.js` → `data/store.json`).

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over copying detail. Keep entries short.
