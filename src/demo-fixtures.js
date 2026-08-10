/**
 * Canonical demo-account fixtures shared by seed.js and server load().
 *
 * These are not user-entered data. They are the fixed *@gridgo.local identities
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
    email: "client@gridgo.local",
    password: DEMO_PASSWORD,
    name: "Ana Client",
    role: "client",
    accountType: "business",
    orgName: "Davao Events Co.",
  },
  {
    id: "user_client_individual",
    email: "individual@gridgo.local",
    password: DEMO_PASSWORD,
    name: "Ivy Individual",
    role: "client",
    accountType: "individual",
  },
  {
    id: "user_supplier",
    email: "supplier@gridgo.local",
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
    email: "rider@gridgo.local",
    password: DEMO_PASSWORD,
    name: "Carlo Rider",
    role: "rider",
    verificationStatus: "approved",
    verificationNote: "Pilot accredited",
    verifiedBy: "user_admin",
  },
  {
    id: "user_ops",
    email: "ops@gridgo.local",
    password: DEMO_PASSWORD,
    name: "Dina Ops",
    role: "ops_admin",
  },
  {
    id: "user_admin",
    email: "admin@gridgo.local",
    password: DEMO_PASSWORD,
    name: "Eli Admin",
    role: "super_admin",
  },
];

/** Emails that are demo fixtures (allowlist). */
export const DEMO_FIXTURE_EMAILS = new Set(DEMO_USERS.map((u) => u.email));
