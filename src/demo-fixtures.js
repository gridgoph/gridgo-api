/**
 * Canonical demo-account fixtures shared by seed.js and server load().
 *
 * These are not user-entered data. They are the fixed *@gridgo.ph identities
 * the apps use for demos. Only emails listed here are fixtures; anything else
 * in the store (captain-created users, orders, credits, …) is real data and
 * must never be rewritten by fixture convergence.
 *
 * Keep in sync with README demo-account table.
 */

/** PrintRight shop pin (Davao). Shared by seed orders + fixture supplier. */
export const DEMO_SUPPLIER_SHOP = {
  lat: 7.064,
  lng: 125.6085,
  label: "PrintRight Davao, C.M. Recto St",
};

/** Repository-visible pilot credential shared by every shipped demo account. */
export const DEMO_PASSWORD = "Ilovegridgo-0990";

/** Production password variables for the fixed pilot identities. */
export const DEMO_PASSWORD_ENV_BY_EMAIL = new Map([
  ["client@gridgo.ph", "GRIDGO_CLIENT_PASSWORD"],
  ["individual@gridgo.ph", "GRIDGO_INDIVIDUAL_PASSWORD"],
  ["supplier@gridgo.ph", "GRIDGO_SUPPLIER_PASSWORD"],
  ["rider@gridgo.ph", "GRIDGO_RIDER_PASSWORD"],
  ["ops@gridgo.ph", "GRIDGO_OPS_PASSWORD"],
  ["admin@gridgo.ph", "GRIDGO_ADMIN_PASSWORD"],
]);

/**
 * Retired fixture addresses, mapped to the identity that replaces each one.
 *
 * `.local` is reserved for multicast DNS, so it was only ever tenable while
 * GRIDGO was a laptop demo. The hosted pilot moved these six identities to the
 * captain's real domain. Stores seeded before that move still hold the retired
 * address, so `migrateFixtureEmailDomain()` in server.js renames them in place
 * on load — an exact-address match only, never a domain-wide rule.
 *
 * This map is a historical record, not a derived value: it must keep listing
 * exactly the addresses that were once shipped, so a fixture added later never
 * implies a rename of a `.local` address that GRIDGO never issued.
 */
export const RETIRED_FIXTURE_EMAILS = new Map([
  ["client@gridgo.local", "client@gridgo.ph"],
  ["individual@gridgo.local", "individual@gridgo.ph"],
  ["supplier@gridgo.local", "supplier@gridgo.ph"],
  ["rider@gridgo.local", "rider@gridgo.ph"],
  ["ops@gridgo.local", "ops@gridgo.ph"],
  ["admin@gridgo.local", "admin@gridgo.ph"],
]);

/**
 * Fixture user records. Keys present here are the only attributes convergence
 * will create or overwrite on a matching store user (plus verifiedAt/verifiedBy
 * when creating an already-approved supplier/rider). Password is the exception:
 * existing fixture users rotate only from the exact retired shipped credential.
 *
 * Identity match: exact email first, else stable seed id. Never match by role
 * alone or by a broad domain rule — that would risk touching real accounts.
 */
export const DEMO_USERS = [
  {
    id: "user_client",
    email: "client@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Ana Client",
    role: "client",
    accountType: "business",
    orgName: "Davao Events Co.",
  },
  {
    id: "user_client_individual",
    email: "individual@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Ivy Individual",
    role: "client",
    accountType: "individual",
  },
  {
    id: "user_supplier",
    email: "supplier@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Ben Supplier",
    role: "supplier",
    supplierName: "PrintRight Davao",
    shop: DEMO_SUPPLIER_SHOP,
    categoryRanks: [
      { categoryCode: "marketing_collateral", rank: 1 },
      { categoryCode: "corporate_event_merch", rank: 2 },
    ],
    verificationStatus: "approved",
    verificationNote: "Pilot accredited",
    verifiedBy: "user_admin",
  },
  {
    id: "user_rider",
    email: "rider@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Carlo Rider",
    role: "rider",
    verificationStatus: "approved",
    verificationNote: "Pilot accredited",
    verifiedBy: "user_admin",
  },
  {
    id: "user_ops",
    email: "ops@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Dina Ops",
    role: "ops_admin",
  },
  {
    id: "user_admin",
    email: "admin@gridgo.ph",
    password: DEMO_PASSWORD,
    name: "Eli Admin",
    role: "super_admin",
  },
];

/** Emails that are demo fixtures (allowlist). */
export const DEMO_FIXTURE_EMAILS = new Set(DEMO_USERS.map((u) => u.email));
