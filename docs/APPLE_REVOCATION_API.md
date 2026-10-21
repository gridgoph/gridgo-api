# Sign in with Apple revocation during account deletion

## Why GRIDGO calls Apple directly

Checked 21 October 2026 against current Clerk documentation, the Backend API
schema, and the installed `@clerk/backend` **3.16.5**:

- [Clerk deleteUser](https://clerk.com/docs/reference/backend/user/delete-user)
  describes removing the Clerk user; it does not promise Apple token revocation.
- [Clerk deleteUserExternalAccount](https://clerk.com/docs/reference/backend/user/delete-user-external-account)
  describes removing the external-account record; it does not promise a call to
  Apple's revocation endpoint.
- [Clerk Backend API schema used by SDK 3.16.5](https://github.com/clerk/openapi-specs/blob/main/bapi/2026-05-12.yml)
  (`SUPPORTED_BAPI_VERSION` in the installed SDK), and the
  [latest published schema](https://github.com/clerk/openapi-specs/blob/main/bapi/2026-08-20.yml):
  `DeleteUser` and `DeleteExternalAccount` document deletion only. The installed
  SDK's implementations in `dist/chunk-XDZN4R63.mjs` forward those DELETE calls;
  they have no explicit Apple exchange/revoke behavior. This cannot establish
  what Clerk does internally, so GRIDGO does not rely on an undocumented guarantee.
- [Clerk native Expo Apple guide](https://clerk.com/docs/expo/guides/configure/auth-strategies/sign-in-with-apple)
  uses the native Apple flow; it distinguishes hosted OAuth, which needs web
  Apple credentials. Native identity authentication alone supplies no documented
  server-side revocation guarantee.
- [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
  describes account deletion and token revocation. The
  [token endpoint](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
  exchanges a fresh authorization code; the
  [revocation endpoint](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
  invalidates the resulting refresh/access token and authorization.

## App sequence (client, supplier, rider)

1. Keep the current Clerk session active. File the existing deletion request via
   `POST /me/account-deletion-request` with `{ "confirmed": true }`. Its `202`
   response and 30-day deadline stay unchanged. Do this even if Apple sign-in
   is cancelled or revocation is unavailable: the deletion request must survive.
2. If the Clerk user has an Apple external account, ask for native Apple
   authentication again using `expo-apple-authentication.signInAsync`. Use the
   fresh credential's `authorizationCode`. Do **not** feed this code to Clerk
   first or reuse a login code: Apple authorization codes are single use and
   short-lived. This step must not switch the active Clerk identity.
3. POST the fresh code to the route below while still authenticated to GRIDGO.
   The `clientId` must be this installed app's exact iOS bundle ID. Do not send
   email, Apple subject, access/refresh token, private key or client secret.
4. After success, end the Clerk session and clear app credentials as appropriate
   to the app's deletion flow. Do not run Apple sign-in again after success;
   that can grant authorization again. Retry a lost API response with the same
   code before asking for a new Apple sign-in. Show failures explicitly; they
   never cancel the deletion request. Do not claim revocation completed on error.

If a person used several GRIDGO apps, each native authorization needs its own
app/bundle flow. A result for one bundle is not evidence for another. Apps without
an Apple link keep the existing deletion flow; web email requests cannot revoke
Apple authorization because they do not prove identity.

## Route and responses

`POST /me/account-deletion-request/apple-revocation`

Requires a Clerk bearer for a mapped identity and its pending deletion request.
Replays of recorded attempts also work after Operations marks that request done.
Available for clients, suppliers and riders even when suspended or removed.

```json
{
  "confirmed": true,
  "clientId": "ph.gridgo.client",
  "authorizationCode": "<fresh native authorizationCode>"
}
```

The deployment allowlist holds the exact client/supplier/rider bundle IDs.
Success is `200`:

```json
{
  "ok": true,
  "requestId": "<deletion request UUID>",
  "appleRevocation": {
    "clientId": "ph.gridgo.client",
    "status": "revoked",
    "attemptedAt": "<ISO timestamp>",
    "revokedAt": "<ISO timestamp>",
    "error": null
  }
}
```

Provider-attempt failures include `{ error, requestId, appleRevocation }` with
`status: "retry_required"`, `revokedAt: null`, and the fixed error code. Failures
before the Apple attempt return `{ error }`. No provider error text is returned.

| HTTP | Error | App action |
| --- | --- | --- |
| 400 | `confirmation_required` | Require explicit deletion confirmation. |
| 400 | `invalid_apple_client_id` | Correct the app bundle ID/configuration. |
| 400 | `invalid_apple_authorization_code` | Obtain a fresh Apple code; it may be expired, consumed or invalid. |
| 401 | `unauthorized` | Restore the caller's Clerk session. |
| 403 | `apple_identity_mismatch` | Apple identity differs from the caller's verified Clerk Apple account. Never revoke it; authenticate with the linked Apple account. |
| 409 | `account_deletion_request_required` | File the deletion request first. |
| 409 | `apple_account_not_linked` | Clerk has no verified Apple provider subject for this identity; do not link by email. |
| 409 | `apple_revocation_in_progress` | Another attempt for this identity is in flight. Retry the same code after a short delay; do not start another Apple sign-in. No code is spent by the refused call. |
| 502 | `clerk_unavailable` | Retry the same request; Apple has not been contacted. Clerk transport, response-body read and parsing have a five-second abortable deadline. |
| 502 | `apple_unavailable` | Apple transport/keys unavailable; obtain a fresh code for a recorded failed attempt. |
| 502 | `apple_token_exchange_failed` | Exchange failed or returned unusable tokens. Retry with fresh Apple authentication after the service recovers. |
| 502 | `apple_identity_invalid` | Signed token failed issuer/audience/expiry/signature checks. No revoke call was made; investigate configuration and retry with fresh authentication. |
| 502 | `apple_revocation_failed` | Apple did not confirm revocation; retry with fresh Apple authentication. |
| 503 | `apple_revocation_not_configured` | Server key/team/key ID/allowlist is missing or invalid. Preserve the deletion request; configuration is required. |

`GET /me/account-deletion-request` lets the owning app resume the pending request.
Operations/Super Admin queue reads and completion responses include the latest
`appleRevocations` entry per bundle. Empty means **unknown**, not not-required.
Completion remains a manual confirmation and is not blocked or automated here.

## Identity, persistence and retry boundaries

The API loads the authenticated user's Clerk account through the server-only
Backend API, pinned to SDK 3.16.5's `2026-05-12` API version. This read uses a
five-second abort signal covering both headers and body; the installed SDK has
no per-request signal option. It takes verified Apple `provider_user_id` values,
projected to `externalAccounts[].providerUserId`
([Clerk object contract](https://clerk.com/docs/reference/backend/types/backend-external-account)),
and compares them to the **verified** Apple token response's `id_token.sub`.
It validates RS256 against Apple's keys, exact issuer, the requested allowed
bundle audience, expiry and issuance time. Caller-supplied subjects or email
never authorize revocation. Mismatch is recorded and makes no revoke call.

The server signs a five-minute ES256 client-secret JWT with the configured P-256
key, then sends form-encoded HTTPS requests to Apple. Refresh token is preferred;
access token is used only when no refresh token was returned. Outbound requests
have ten-second timeouts and refuse redirects.

Each request/client/code SHA-256 digest identifies an attempt. No raw code,
Apple identity/access/refresh token, client secret, Apple subject, or private key
is persisted or logged. Replaying the same code returns the exact recorded
result without another Apple exchange, audit or notification after the active
attempt completes. Concurrent attempts return `409 apple_revocation_in_progress`
instead of waiting. Failed codes are
also replayed; a new attempt needs a fresh sign-in/code. A fresh code always
triggers a new revoke even after success because that sign-in may reauthorize
the app. Latest attempts per bundle are shown to Operations; earlier attempts
remain durable in `account_deletion_apple_revocations` and the audit log.
Each result emits `account_deletion_apple_revoked` or
`account_deletion_apple_revocation_failed` to every current Operations and Super
Admin membership, plus the staff-scoped `account-deletion-requests` invalidation.
Neither push nor invalidation payloads contain codes, tokens or contact details.

Per-process admission rejects duplicate work before outbound Clerk calls, which
hold no pooled database connection. A per-user **nonblocking** transaction
advisory lock (`pg_try_advisory_xact_lock`) then admits Apple work across API
replicas; busy calls promptly roll back and release their pooled connection.
Recorded results and pending-request ownership are rechecked after admission.
Result rows, audits and staff inbox notifications commit together, taking the
domain lock only after the Apple calls; provider latency does not block order or
payment mutations. An Apple call cannot participate in a
PostgreSQL transaction: a process/commit failure after an external call may
consume the code or revoke authorization without leaving a database result.
If no recorded result exists and retry reports an invalid code, obtain fresh
Apple authentication and revoke again. The API never treats an invalid/used
code or a timeout as proof of revocation. Tokens are kept only in request memory,
so there is no automatic retry of an exchanged token after a failure.

Deployment variables and key setup: [Deployment](DEPLOYMENT.md). Forward
migration `1792539400000` is required. App screen changes are a separate release.
