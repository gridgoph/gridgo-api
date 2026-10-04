# Tracker decision issue bodies

Captured on 2026-10-04 from `gridgoph` issues: gridgo-api #117, #123,
#125, #131–#133; gridgo-client #170; gridgo-rider #76; gridgo-web #115–#116.
These are full, unchanged GitHub issue bodies, including their tracker markers.
Tests read these local fixtures only; they never contact GitHub.

Capture command: `gh-axi issue view <number> -R gridgoph/<repo> --json body --full`.
The wrapper prints the body as a JSON-escaped string under `issue.body`; each
fixture stores that decoded string in a `{ "body": "…" }` JSON object.
