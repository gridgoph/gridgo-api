# Android and iPhone early access

This is the landing site's public Android/iPhone waitlist. It creates no GRIDGO
or Clerk account. Staff enrollment stays manual for both phone types:

- Android: add the submitted Google account to the client's Play closed-test
  group, then grant access. GRIDGO emails the existing Play opt-in invite.
- iPhone: add the submitted Apple ID email in App Store Connect under the client
  app's TestFlight external testers, then mark it added through the same grant
  endpoint. Apple sends its own TestFlight invite; GRIDGO sends no applicant email.

This flow records staff decisions without managing Google Group membership or
App Store Connect. Before the website rollout, confirm client-app TestFlight
external testing is set up and the existing invite staff can add testers; stop
for an operational decision if either condition is unmet. Existing in-app
enrollment is unchanged; see [Play opt-in](PLAY_OPTIN_API.md).

## Public routes

The existing exact-origin `CORS_ALLOWED_ORIGINS` policy applies, as for issue
reports. No bearer is required. Responses use `Cache-Control: private, no-store`
and `Referrer-Policy: no-referrer`. `/api/early-access...` aliases also work.

`POST /early-access`:

```json
{ "email": "tester@gmail.com", "consent": true, "source": "booth", "platform": "android" }
```

Email is trimmed, lowercased and syntax-validated. For Android submit the Google
Play account email (custom domains are accepted); for iPhone submit the Apple ID
email (not restricted to iCloud domains). No provider ownership check is performed.
`consent` must be the boolean `true` (`400 consent_required`). Optional `platform`
is exactly `android` or `iphone`; omission defaults to `android` for existing
website builds. Every other value, including null, returns `400 invalid_platform`.
Optional `source` is the referral code, a lowercase slug, 1–64 characters,
matching `[a-z0-9][a-z0-9_-]*`; omitted, null or
empty becomes null. Invalid values return `400 invalid_email` or
`400 invalid_source`. Malformed JSON is `400 invalid_json`; bodies over 4 KiB
are `413 request_body_too_large`.

Returns `200` on both first submission and repeat submission:

```json
{
  "token": "<64 lowercase hex characters>",
  "platform": "android",
  "status": "pending",
  "createdAt": "2026-11-17T10:00:00.000Z",
  "grantedAt": null,
  "duplicate": false
}
```

The canonical email is unique across both phone types. Repeating it returns the
original token, stored `platform`, dates and current status with `duplicate: true`,
even if the repeat supplies another phone type or omits it. It does not replace
the first phone type, source or consent time, send another team email or create
another notification. Consent is still required on a repeat submission. Ten
submissions per IP per hour are
allowed, including invalid attempts; excess returns `429 rate_limited`.

`GET /early-access/status?token=<token>`:

```json
{ "platform": "android", "status": "pending", "grantedAt": null, "optInUrl": null }
```

Both signup and status responses include the stored `platform` so a recovered
token displays the correct phone's instructions. Once granted, `status` is
`granted` and `grantedAt` is an ISO timestamp. Android's `optInUrl` is the Play
invite link. iPhone's `optInUrl` remains null, including after grant:

```json
{ "platform": "iphone", "status": "granted", "grantedAt": "2026-11-19T10:00:00.000Z", "optInUrl": null }
```

For iPhone, show success based on `status === "granted"`; do not require a link.
This means staff recorded the tester as added, not that Apple's invite has been
delivered or accepted. Unknown/malformed tokens return `404 not_found`.
No email or staff identity is returned. Status polling allows 120 reads per IP
per minute (`429 rate_limited`). Both limits use the same process-local IP
limiter/proxy handling as support reports; each API instance has its own buckets.

The browser should retain the token for the waiting page and poll every 30
seconds. A five-minute countdown is advisory, not a grant promise. At 15 minutes,
Android keeps its Spam reminder and APK fallback. iPhone copy should direct the
applicant to install TestFlight first and check for Apple's email invite; do not
show the Android APK fallback or a Play link. Closing the page is safe: access
is handed off through email. Treat the token as private, do not send it to analytics,
and use a no-referrer policy on the waiting page. Per the shared contract,
resubmitting the email recovers its token/status without email verification; it
must not be used as an identity/authentication credential.

## Staff list and grant

Operations/Super Admin use their GRIDGO Clerk session/database memberships:

- `GET /ops/early-access`
- `POST /ops/early-access/:id/grant`

The landing support desk uses the existing verified primary-email allowlist
`SUPPORT_DESK_ALLOWED_EMAILS` with its Clerk bearer:

- `GET /early-access/desk`
- `POST /early-access/desk/:id/grant`

Desk routes also accept `/api` aliases. Anonymous access is `401 unauthorized`;
other accounts are `403 forbidden`; an empty desk allowlist is
`503 desk_unconfigured`. No local desk password or service token is accepted.

List parameters: `status=pending|granted` (optional), `q` (case-insensitive literal
email substring, at most 254 characters), `limit` (1–100, default 50), `offset`
(0–1,000,000, default 0). Invalid filters/paging return `400 invalid_status`,
`invalid_query` or `invalid_pagination`. Rows are newest first with ID as a stable
tie-breaker. Counts apply to `q` across both statuses, before the status filter:

```json
{
  "signups": [{
    "id": "<uuid>", "email": "tester@gmail.com", "source": "booth",
    "platform": "android", "status": "pending",
    "createdAt": "2026-11-17T10:00:00.000Z", "grantedAt": null, "grantedBy": null
  }],
  "counts": { "pending": 1, "granted": 0 },
  "total": 1, "limit": 50, "offset": 0
}
```

`total` counts rows matching both filters. Lists never expose the public token.
This repo serves JSON only; the landing/dashboard repos render the desk page.
Use `createdAt` for date, `email`, `platform` (labels **Android**/**iPhone**),
`source` for the referral code, and `status` for **Pending**/**Added**. The API
keeps the existing `pending|granted` vocabulary; **Added** maps to `granted`.
Grant needs no JSON fields. It returns `200` with the single staff row above,
updated to `granted`. `grantedBy` is the GRIDGO actor ID for ops/super or the
verified Clerk subject for desk operators. Unknown/malformed IDs return
`404 not_found`. A repeated grant returns the original decision without a second
audit event or email. For Android, the client `optInUrl` from
`/ops/testers/settings` is snapshotted at grant, so the status page and invite email agree after settings
changes. Granting neither starts nor proves Google's 14-day testing clock.
iPhone grants do not read Play settings, store a Play link, or queue a Play
invite email. Staff must add the tester in App Store Connect before granting;
there is no TestFlight automation or change to who handles invites.

## Persistence, notifications and mail

Migration `1794916800000` creates `early_access_signups` and
`early_access_email_outbox`. Migration `1794918600000` adds the shared
`early_access_team_mail_budget` delivery ledger. Migration `1795068000000` extends
the existing platform constraint to `android|iphone`, defaults omitted database
values to Android, and permits granted iPhone rows only with a null Play link.
Existing rows already have non-null `android` enforced by the original constraint;
they keep that value and all original consent/grant facts without a data rewrite.
Apply this forward migration before deploying the API or enabling iPhone signup
in the website. Every signup/grant mutation uses one domain-locked transaction.
Consent time, sign-up/grant, audit evidence, mail intent and the new
sign-up/grant's durable ops/super inbox notifications commit atomically. Duplicate
submissions/grants add none. Notifications use `notifyAdmins` and `save()` with a
staff-only `early-access` refetch; no notification/push copy contains an email.

Server-only configuration (never put these in a browser build):

```dotenv
EMAIL_USER=<existing Gmail sender>
EMAIL_PASSWORD=<existing Gmail app password>
EARLY_ACCESS_TEAM_EMAIL=<team inbox>
```

New sign-ups queue `New Android tester: <email>` or `New iPhone tester: <email>`
to that inbox. The alert body gives the corresponding manual enrollment steps.
Android grants queue the client Play opt-in link and **Keep the app for 14 days.**
to the applicant, with the existing subject and body unchanged. iPhone grants
queue no applicant email; Apple's TestFlight invite supplies it. The shared
nodemailer transport sends only after commit, outside transaction locks. No SMTP
error content, email, request body or token is logged. Mail failures never fail
the HTTP mutation. The single-flight worker runs immediately after new mail
commits and on the existing lifecycle retry tick. A claim is leased for five
minutes across API instances; failures retry after five minutes, up to eight
attempts. Each claim prioritizes a due `access` invite over every due `team`
alert; an SMTP send already in flight is allowed to finish. Access invites do not
consume the team budget and remain deliverable when it is exhausted.

Team alerts for both phone types share one database-backed aggregate budget of
**100 SMTP delivery attempts per UTC calendar day**, across all source IPs,
API instances and restarts. The claim and budget debit commit together under the domain advisory
lock; retries and failed sends consume the allowance too. Missing SMTP/recipient
configuration does not consume it. Excess team intents remain pending without an
attempt increment and resume automatically after the next UTC midnight; each
accepted signup still owns exactly one durable team intent. The budget ledger
contains only a UTC date and attempt count, never an email. A public signup flood
can create a team-alert backlog, but cannot spend more than this team allowance
or put queued alerts ahead of due access invites. Staff can still see every
accepted signup immediately in the list/inbox. Apply both migrations before
replacing all API instances; old mail workers cannot enforce the new budget.

Deterministic Message-IDs help deduplication, but SMTP delivery is at
least once if a process dies after delivery and before recording success.

Missing SMTP configuration leaves all mail pending; a missing team recipient
leaves team alerts pending while applicant invites can still send. Installing
the server variables and restarting resumes pending work. Operators can inspect
outbox `kind`, `status`, `attempts` and `next_at` without exposing addresses.
`failed` rows need an operator to investigate SMTP configuration and deliberately
reset attempts/status/next_at in an audited operational session; repeated grant
requests deliberately do not resend. Apply the migration before starting the
new API, configure SMTP/recipient and the actual client Play opt-in URL before
publishing the website. No new dependency or schema-at-boot behavior is added.
