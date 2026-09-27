# Artwork link response fixtures

Captured anonymously on 2026-09-27 using curl (no cookies/authorization).
Public source: https://www.canva.com/design/DAF9RMb6BGM/kJN60E_r3FOTSq0z0tCGcQ/view
The design is the publicly advertised WUST presentation preview by Goashape Studio.

`canva-public.html` contains verbatim title/Open Graph tags and the bootstrap
VIEWER/design-id prefix extracted from the actual 200 HTML response. Wrapper and
closing syntax are reconstructed. All remaining document data, script assets,
nonces, signed media URLs and response cookies are omitted. The full response
was 778616 bytes (SHA-256 4080874f47186345af1044f9495c1274ccc8734d29d52e02850008f1317725b2).
The evidence appears within the first 13 KiB. Tests add synthetic padding to
exercise the original response's over-64-KiB behavior without keeping the design.

Capture user agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36.
The original GRIDGO checker user agent returned 200 with the title
`Unsupported client – Canva`; `canva-unsupported.html` preserves that title.

Two anonymous edit attempts returned Cloudflare 403, not a private-design access
verdict. Firstmate explicitly approved replacing the private capture requirement
with synthesized fixtures. `loginRedirect`, `login`, `missing`, and `short` are
synthesized responses. `challenge` is a synthesized minimal representation of
the observed 403/content-type/cf-mitigated headers and status-page script.
`files` contains standard magic-byte prefixes; large file payloads are generated
locally. No test contacts Canva or any other internet service.
