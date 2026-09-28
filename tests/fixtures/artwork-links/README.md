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

## Drive and missing-page follow-up (#108)

Captured anonymously with curl on 2026-09-28, using
`GRIDGO-Artwork-Link-Check/1.0`, no cookies or authorization. No Google account
or API key was used. `drive-responses.json` records status, Content-Type and
redirect Location only; response cookies and unrelated headers are omitted.

- Public PNG: https://drive.google.com/file/d/1p_QOQ3CgMKiava0lRAP9exkZP9sNm5Fw/view
  (public MEDIA FILES logo, discovered through its publicly indexed folder).
  `drive-public.html` extracts the actual title/OG tags and viewer config;
  wrapper/closing syntax is reconstructed. The config begins at byte 57113.
  Signed preview assets, API bootstrap keys, nonces and document payload are omitted.
- `/uc?export=view&id=…` returned 303 to the exact
  `drive.usercontent.google.com/download` host, which returned 200 image/png.
  `drive-png-prefix.bin` retains only its first 32 bytes; tests generate padding.
- Private/restricted file: https://drive.google.com/file/d/1ALFYwrnCMmF2OURQWQDoaaSQuKDs25oD/view?hl=en
  (link published in https://support.google.com/drive/thread/158649959/please-help-me-to-the-download-files?hl=en).
  Anonymous view returned 401; `drive-private.html` retains actual sign-in copy.
  `/uc` returned 303 to usercontent, then 302 to accounts.google.com.
  No private file content was accessed or retained.
- Made-up Drive ID `GRIDGONonexistentFile108` returned 404; title retained.
- Made-up Canva ID `GRIDGONonexistent108` returned 403 with
  `cf-mitigated: challenge` using the fixed browser user agent. Existing challenge
  fixture represents this result; it must remain unknown.
- `accessPage`, `deletedPage`, and `canvaMissingPage` are explicitly synthesized
  error-copy fixtures, not claimed live captures. Trashed/wrong-ID/challenge
  mutations and slow-HEAD timing cases are synthetic regressions.

Raw capture SHA-256 (uncommitted raw responses contain provider session data):

- `png.html`: 79804 bytes, `3e6dc0d28e4cb37bb9b5686b0a46a1eb5be184a9f1be8adc0cb7f2f6b97b2120`
- `png-bytes.bin`: 180907 bytes, `0d393d1d7020929aa821618b4aebc53af791bb7ea78bd28f15f5b52c79300e20`
- `1ALFYwrnCMmF2OURQWQDoaaSQuKDs25oD.html`: 9102 bytes, `50e8777acf8ad6861cd0be946662daf7bb207b7816063a40d65008f6612a9e26`
- `private-download.headers`: 2072 bytes, `7959f5c48a082a283cbcafe743e6ffc69423474012745b251bb4ec943115d64c`
- `missing.html`: 3268 bytes, `8665318a2f465e7a25e44d87736fbedc0b1290864a1788959ff1b65ca1c514c5`
- `canva-missing.html`: 755055 bytes, `705a5321f8bdc67ff8e62c225a71d37579f78c5a60e5310f25a918caf8d43fa9`
