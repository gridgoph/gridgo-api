/**
 * Canonical demo-account fixtures shared by seed.js and server load().
 *
 * Official Development Client / Supplier / Rider people are the Clerk trio
 * in OFFICIAL_DEV_USERS. Do not advertise *@gridgo.ph as those roles.
 *
 * HOSTED_LEGACY_USERS are the six talasora identities. Production still
 * configures their GRIDGO_*_PASSWORD values. Local seed keeps them so
 * scenario orders stay on user_client / user_supplier / user_rider and a
 * live hosted store is not rewritten onto Gmail. Never rename those ids
 * onto the official emails.
 *
 * Identity match: exact email first, else stable seed id. Never match by
 * role alone or by a broad domain rule — that would risk touching real
 * accounts.
 *
 * Keep advertised DEMO_USERS in sync with the README demo-account table.
 */

/** PrintRight shop pin (Davao). Shared by seed orders + both supplier fixtures. */
export const DEMO_SUPPLIER_SHOP = {
  lat: 7.064,
  lng: 125.6085,
  label: "PrintRight Davao, C.M. Recto St",
};

/** Repository-visible pilot credential shared by every shipped demo account. */
export const DEMO_PASSWORD = "Ilovegridgo-0990";

/**
 * Production password variables for the hosted talasora identities only.
 * Official Development Clerk emails must never appear here.
 */
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

const HOSTED_SUPPLIER_FIELDS = {
  supplierName: "PrintRight Davao",
  shop: DEMO_SUPPLIER_SHOP,
  categoryRanks: [
    { categoryCode: "marketing_collateral", rank: 1 },
    { categoryCode: "corporate_event_merch", rank: 2 },
  ],
  verificationStatus: "approved",
  verificationNote: "Pilot accredited",
  verifiedBy: "user_admin",
};

/**
 * Hosted talasora identities. Production fixtures, and unadvertised local
 * scenario users so demo orders keep their original foreign keys.
 */
export const HOSTED_LEGACY_USERS = [
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
    ...HOSTED_SUPPLIER_FIELDS,
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

/**
 * Official Development Clerk people. New stable ids — never user_client /
 * user_supplier / user_rider — so hosted orders stay on Ana / Ben / Carlo.
 *
 * Prefer the ids already used in local stores (user_fely_client,
 * user_test_supplier, user_test_rider). Do not invent a second shop pin.
 */
export const OFFICIAL_DEV_USERS = [
  {
    id: "user_fely_client",
    email: "felyciaaa0220@gmail.com",
    password: DEMO_PASSWORD,
    name: "Fely Cia",
    role: "client",
    accountType: "individual",
    clerkUserId: "user_3HuDW6IvEhi6u0ZThyi2RaCatbW",
  },
  {
    id: "user_test_supplier",
    email: "markdavidprado@gmail.com",
    password: DEMO_PASSWORD,
    name: "Mark David Prado",
    role: "supplier",
    clerkUserId: "user_3HuZUbk8F3v6ezlZAwSgK7gY8jB",
    ...HOSTED_SUPPLIER_FIELDS,
  },
  {
    id: "user_test_rider",
    email: "mddprado00290@usep.edu.ph",
    password: DEMO_PASSWORD,
    name: "Mark David Prado",
    role: "rider",
    clerkUserId: "user_3HuZUmc9fIEb9UvvtXmSjoG434d",
    verificationStatus: "approved",
    verificationNote: "Pilot accredited",
    verifiedBy: "user_admin",
  },
];

export const OFFICIAL_DEV_USER_IDS = new Set(OFFICIAL_DEV_USERS.map((u) => u.id));
export const OFFICIAL_DEV_EMAILS = new Set(OFFICIAL_DEV_USERS.map((u) => u.email));

/** Remaining advertised platform fixtures while hosted AUTH_MODE is legacy. */
export const PLATFORM_USERS = HOSTED_LEGACY_USERS.filter(
  (u) => u.role === "ops_admin" || u.role === "super_admin",
);

/**
 * Advertised local logins: official Clerk trio plus ops / super.
 * Not the production fixture set — see HOSTED_LEGACY_USERS.
 */
export const DEMO_USERS = [...OFFICIAL_DEV_USERS, ...PLATFORM_USERS];

/**
 * Local seed + local fixture convergence. Official trio first, then the
 * hosted six so scenario FKs and ops/admin remain. Production uses only
 * HOSTED_LEGACY_USERS via configuredDemoUsers().
 */
export const LOCAL_SEED_USERS = [...OFFICIAL_DEV_USERS, ...HOSTED_LEGACY_USERS];

/** Emails that are advertised local fixtures. */
export const DEMO_FIXTURE_EMAILS = new Set(DEMO_USERS.map((u) => u.email));

/** Emails of the six hosted identities (retirement-map targets). */
export const HOSTED_LEGACY_FIXTURE_EMAILS = new Set(HOSTED_LEGACY_USERS.map((u) => u.email));
