# Shop onboarding to live

Refs gridgoph/gridgo-api#456 and gridgoph/gridgo-supplier#309. Reports
**2EBCAAF0** and **36D02739**. This is the API contract; companion app screens
and authentication-provider password policy are separate releases.

Apply forward migration `1795809000000_supplier_onboarding_live` before upgrading
API processes. It preserves existing rows, service states, listing decisions,
orders and payout plans. Drain older API processes before enabling the release
controls: older matchers cannot implement the new completion and home pickup
policy.

## Release controls

Super Admin alone edits the following through `PATCH /settings`, with the usual
`expectedVersion` and reason. The ordinary settings audit records old/new values.

```json
{"expectedVersion":12,"reason":"Approved onboarding release","supplierOnboarding":{"autoApproveDocuments":true,"unverifiedShopsEnabled":true}}
```

**Both switches default to false in production.** Migration and `npm run seed`
keep Operations review on and do not auto-publish any shop. Explicit development
`npm run seed:dev` enables both; tests opt in with fixture settings. Production
activation requires the release decision. `autoApproveDocuments` permits the
narrow standard-document approval at finish. `unverifiedShopsEnabled` permits a
completed tier-price signup to match and receive capped online payouts while
identity verification is pending. Turning it off pauses new work and new payout
preparations for those shops; frozen manual-transfer attempts still reconcile.
Existing pending shops keep the released verification policy.

Verification stays separate: a finish never approves an identity, creates a
verification document, marks a home printer as staff-reviewed, or removes holds.

## One account, save and resume

Use a verified Clerk session with `GET`/`PATCH /auth/clerk/supplier-signup` and
`{expectedVersion,step,value}` as in [guided signup](SUPPLIER_SIGNUP_API.md).
A signed-in client uses the same subject and receives an additional supplier
membership, profile and approval case. The client membership remains. There is
one application per role; another key cannot create a second supplier case.
Different subjects are never linked by matching email. Staff invite claims keep
the same existing identity rules. No password-policy call is made by this API.

Save `eligibility` (`shopKind`, `registrantRole:"owner"`, `adult:true`), `shop`
(`shopName`, contact name and Clerk-verified mobile) and consented `location`.
The API stores the entered shop name in `supplier_profiles.shop_name` and the
legacy supplier-name compatibility field. Auth, catalogue and map projections
use that profile. Empty names and the historical placeholder `Temporary` are
refused on signup and profile edits. Existing placeholder rows expose the
`shop_name` readiness blocker; they are never silently renamed. Repository
tracing found no hard-coded writer of that placeholder in enrollment, seed or
Operations paths; no external data source is inferred or rewritten.

Managers and staff join through the existing shop-team invitation flow. Legacy
manager-led signup remains compatible, but cannot use this owner-only finish.

For a home printer, save the existing private home location first, then `pickup`:

```json
{"expectedVersion":3,"step":"pickup","value":{"mode":"guardhouse","point":{"lat":7.06,"lng":125.6},"description":"Entrance waiting area","consent":{"accepted":true,"wording":"<homePickupPointConsentWording>"},"privacyAgreement":{"accepted":true,"wording":"<homeFilePrivacyWording>"}}}
```

Modes: `gate | guardhouse | landmark | delivery_only`. Delivery-only omits the
point and has no client pickup. GET returns both exact consent wordings. The
server records consent times. The meeting point stays private on the home
profile and is snapshotted onto accepted orders; existing accept-first order
privacy reveals it only to the owning client after acceptance until pickup or
cancellation, and to the assigned rider for delivery. Public locations stay
null and distances remain rounded. Home printers offer standard documents,
QR payment and the existing manual-payment order cap only.

## Shop-owned prices and hours

Save `prints` with `groups:["documents"]` and the existing `papers`, `colours`,
`duplex`, optional finishing fields, plus `documents.pricesMinor`:

```json
{"papers":["a4","long","a3"],"colours":["bw","colour"],"duplex":true,"pricesMinor":{"a4":{"bw":200,"light":500,"full":900},"long":{"bw":400,"light":700,"full":1200},"a3":{"bw":1000,"light":1500,"full":2000}},"finishing":{}}
```

All three tiers are required for each offered paper. Include Long and A4 or
Short (both may be offered). A3 is optional for print shops and unavailable to
home printers. Amounts are positive, safe-integer PHP minor units divisible by
100: whole pesos only. Each generated document listing stores the same
`expressPricing` structure already consumed by per-page Express colour pricing.
B&W, Light and Full use the shop's own prices; the configured light-colour
threshold remains `expressLightColourMaxBps` (default 2500). Legacy signup
without `pricesMinor` retains its released rate contract. Neither a guide nor a
future settings edit changes saved shop prices or accepted order money.

Optionally save `hours` with `{schedule}` before enrollment; otherwise use
`PATCH /me/shop-hours` after enrollment. The existing Asia/Manila weekly schedule
is stored on the supplier profile. New home-printer listings respect those
hours too. Enroll internally after the contact/location/prints steps using the
current draft version and the existing idempotent supplier enrollment route.
Then upload the required private `supplier_payout_qr`, save the existing payout
account with `holder:"mine" | "family" | "business"`, and give the exact returned
`payoutConsentWording`. The QR recipient name may differ from the owner; there
is no name-match rule. Existing legacy holder values remain compatible.

## Area price guides

`areaPriceGuides` is a bounded Super Admin setting (up to 100 entries):

```json
[{"name":"Central district","lat":7.06,"lng":125.6,"radiusMeters":1500,"ranges":[{"paper":"a4","tier":"bw","minMinor":100,"maxMinor":400}]}]
```

Ranges use `a4 | short | long | a3`, `bw | light | full`, and positive whole-peso
minor-unit bounds with min <= max. Signup GET/PATCH returns nearby guides,
nearest first, as `{name,ranges}` after the pin is saved. Empty configuration
returns `[]`; do not invent a market range. These are **Area price guides** for
an onboarding hint, independent of client fees and checkout arithmetic.

## Finish and review boundaries

`POST /me/supplier-signup/finish` takes `{expectedVersion}` from signup. Only an
active shop Owner may finish. Owner/adult attestation, name, pin, tier prices,
valid saved hours, a fully ready owning-shop payout QR and holder consent are
required. Home pickup/privacy choices are required for home printers. Missing
facts return `409 supplier_signup_incomplete`; a stale draft version returns
`409 supplier_signup_stale`. A replay at the returned version is idempotent.

With the controls enabled, finish approves only pristine generated Short/A4/Long
Express document listings, exempts those standard listings from sample-photo
requirements, and makes their service line live. A3 and finishing stay pending
normal review and retain photo requirements. Supplier edits/private revisions,
rejections, account suspensions and staff take-downs are never overridden.
Rejecting a pending identity suspends its live services with the ordinary case
provenance. No existing service or listing is auto-converted by migration.

With controls off, finish saves completion but leaves listing/service review
pending; its response has `live:false`. The response includes `signup` and
`payoutStatus`. Read actual operational readiness before saying a shop is on the
map. Audit, privileged inbox rows and catalogue invalidation commit with finish.

For older shops, `GET /me/supplier-readiness` adds
`onboarding:{nextMissing:{code,message,action}|null,remainingCount}`. Render only
that next item. Codes derive from existing shop/listing readiness, with explicit
hours and placeholder-name checks; subsequent reads advance as facts are fixed.

## Verification and every payout path

Default policy remains 30 days from supplier membership/home enrollment and
PHP 5,000 total online payouts before verification. Reopening or completing
signup does not reset the start, cap or ledger. Expiry prevents new work while
existing accepted jobs can finish. Verification lifts the cap through the
existing staff decision contract.

Milestones (including legacy automatic retention and Express handover), refund
settlement remainders, supplemental order-change payouts, daily transfers and
launch bonuses all use the shared verification reservation/paid ledger. Pending
manual attempts consume capacity before a transfer; retries cannot spend it
again. Bonuses on cash orders also reserve cap capacity. Zero-net recovery
offsets do not consume additional transfer capacity. New tier-signup shops
cannot use rider-paid cash or funded cash reprints/replacements while
unverified: those routes fail closed with `cash_supplier_verification_required`.
Existing issued cash protocols retain their compatibility contract.

Deferred PostgreSQL guards enforce the cap and production-off gate for direct
legacy writes as well as HTTP. Home verification uses the full Starter plus
permit/clearance and tax-document requirements, rather than identity approval
alone. Frozen in-flight transfers remain reconcilable and independent
claim/refund/destination/ownership holds still apply. See
[verification](SUPPLIER_VERIFICATION_API.md) for prepare/record/reconcile calls.
