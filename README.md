# gridgo-api

**Local demo backend for every GRIDGO app** (client, supplier, rider, and later ops).

Temporary and replaceable. No Clerk, Supabase, PayMongo, or cloud accounts. JSON file storage on disk. Swap later by keeping the same route contracts and pointing the apps at a real backend.

## Quick start

```bash
npm install   # no runtime deps today — pure Node
npm run reset # seed demo users + sample orders
npm run dev   # http://127.0.0.1:8787
```

Health: `GET /health`

## Demo accounts

| Email | Password | Role |
|---|---|---|
| `client@gridgo.local` | `demo` | client |
| `supplier@gridgo.local` | `demo` | supplier |
| `rider@gridgo.local` | `demo` | rider |
| `ops@gridgo.local` | `demo` | ops_admin |
| `admin@gridgo.local` | `demo` | super_admin |

Login: `POST /auth/login` `{ "email", "password" }` → `{ token, user }`

Send `Authorization: Bearer <token>` on subsequent requests.

## Mobile apps

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:8787 npm start
```

On a physical phone, use your machine's LAN IP (e.g. `http://192.168.1.10:8787`).

## Design principles

- **One API for all roles** — role from the session, not from which app calls it
- **Money in PHP minor units** (centavos as integers)
- **Pilot payments only** — Pilot Credits + COD ≤ ₱1,500; no live PayMongo
- **Order state machine** matches the PRD (simplified transitions for demo)
- **Replaceable** — apps should only talk through `lib/api.ts`; swapping providers means a new server that honors the same routes

## Main routes

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | issue token |
| GET | `/auth/me` | any | current user + role |
| GET | `/catalog` | client | product catalog |
| GET | `/orders` | role-scoped | list orders/jobs |
| POST | `/orders` | client | create draft/submit request |
| POST | `/orders/:id/transition` | role-gated | advance state |
| GET | `/credits/balance` | client | pilot credit balance |
| POST | `/credits/authorize` | client | reserve/spend for order |
| GET | `/dispatch/offers` | rider | open delivery offers |
| POST | `/dispatch/:id/accept` | rider | accept job |
| POST | `/dispatch/:id/location` | rider | location ping |
| POST | `/dispatch/:id/proof` | rider | pickup/delivery/COD proof |
| GET | `/notifications` | any | in-app alerts |

## Replace later

| Demo today | Production later |
|---|---|
| Bearer token in JSON store | Clerk session + role claim |
| `data/store.json` | Supabase Postgres + RLS |
| In-process transitions | Edge Functions + idempotency keys |
| Simulated COD/credits | Pilot credits ledger + PayMongo adapter |

Keep route shapes stable so mobile apps do not need a rewrite when you swap.

## Android emulator API URL

From the **Android emulator**, `127.0.0.1` is the emulator itself. Use:

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:8787 npm start
```

Physical device / Expo Go on phone: use the host LAN IP (e.g. `http://192.168.1.55:8787`).
