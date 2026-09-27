import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import http from "node:http";
import { createArtworkLinkChecker, validateArtworkLinks, resolveArtworkLinks } from "../src/artwork-links.js";

// Only the transport dial is substituted: URL parsing, DNS address policy,
// pinning, redirect handling and bounded HTTP reads all run normally.
async function mockChecker(t, respond, extra = {}) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); respond(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const checker = createArtworkLinkChecker({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: (url, options, callback) => {
      options.lookup(url.hostname, {}, (err, address, family) => {
        assert.ifError(err);
        assert.equal(address, "93.184.216.34");
        assert.equal(family, 4);
      });
      assert.equal(options.agent, false);
      return http.request({ ...options, hostname: "127.0.0.1", port: server.address().port, path: url.pathname + url.search, headers: { ...options.headers, Host: url.host } }, callback);
    },
    ...extra,
  });
  return { checker, seen };
}

test("link checker refuses non-public DNS, IP literals, credentials and scheme tricks before dialing", async () => {
  const checker = createArtworkLinkChecker({ lookup: async () => [{ address: "10.1.2.3", family: 4 }], request: () => { assert.fail("unsafe address was dialed"); } });
  for (const url of ["http://localhost/", "https://10.0.0.1", "https://169.254.1.2", "https://127.1", "https://2130706433", "https://0x7f000001", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[fc00::1]", "https://[fe80::1]", "https://100.64.0.1", "https://168.63.129.16", "https://public.example", "https://localtest.me"]) {
    await assert.rejects(checker({ url, formatCode: "other_link" }), { code: "unsafe_artwork_url" });
  }
  for (const url of ["file:///etc/passwd", "ftp://example.com/a", "https://user:pass@example.com", "https://example.com/\npath"]) {
    await assert.rejects(checker({ url, formatCode: "other_link" }), { code: "invalid_artwork_link" });
  }
  const mixed = createArtworkLinkChecker({ lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }], request: () => assert.fail("mixed DNS was dialed") });
  await assert.rejects(mixed({ url: "https://example.com", formatCode: "other_link" }), { code: "unsafe_artwork_url" });
});

test("link checker follows at most three redirects and refuses private redirect targets", async (t) => {
  const { checker, seen } = await mockChecker(t, (req, res) => {
    res.writeHead(302, { Location: req.url === "/private" ? "http://169.254.169.254/latest/meta-data" : "/loop" }); res.end();
  });
  await assert.rejects(checker({ url: "https://example.com/private", formatCode: "other_link" }), { code: "unsafe_artwork_url" });
  assert.equal(seen.length, 1);
  const result = await checker({ url: "https://example.com/loop", formatCode: "other_link" });
  assert.equal(result.ok, false);
  assert.equal(result.access, "unknown");
  assert.match(result.message, /redirect/i);
  assert.equal(seen.length, 5);
});

test("provider detection uses exact domain boundaries and HTML never proves edit rights", async (t) => {
  const { checker, seen } = await mockChecker(t, (req, res) => {
    if (req.url === "/gone") { res.writeHead(404); return res.end(); }
    if (req.url === "/private") { res.writeHead(302, { Location: "/login" }); return res.end(); }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/login" ? '<form><input type="password"></form>' : '<html><title>Design</title><script>editor()</script></html>');
  });
  for (const [url, provider] of [["https://www.canva.com/design/ABC/view", "canva"], ["https://www.canva.com/design/ABC/edit", "canva"], ["https://drive.google.com/file/d/ABC/view", "google_drive"], ["https://www.dropbox.com/s/ABC/file", "dropbox"], ["https://www.figma.com/design/ABC", "figma"], ["https://canva.com.evil.example/design/a/edit", "other"]]) {
    const result = await checker({ url, formatCode: "other_link" });
    assert.equal(result.provider, provider);
    assert.equal(result.access, "unknown");
    assert.equal(result.reachable, true);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 200);
  }
  assert.deepEqual(seen.slice(0, 2).map((r) => r.method), ["HEAD", "GET"]);
  assert.ok(seen.every((r) => (r.headers["user-agent"] === "GRIDGO-Artwork-Link-Check/1.0" || r.headers["user-agent"].startsWith("Mozilla/5.0")) && !r.headers.authorization && !r.headers.cookie));
  const login = await checker({ url: "https://www.canva.com/private", formatCode: "canva_link" });
  assert.equal(login.access, "sign_in_required");
  const missing = await checker({ url: "https://www.canva.com/gone", formatCode: "canva_link" });
  assert.equal(missing.access, "not_found");
  assert.equal(missing.httpStatus, 404);
});

test("HEAD refusal falls back to GET; actual public image content supports view only", async (t) => {
  const { checker, seen } = await mockChecker(t, (req, res) => {
    if (req.method === "HEAD") { res.writeHead(405); return res.end(); }
    res.setHeader("Content-Type", "image/png");
    res.end(Buffer.from("89504e470d0a1a0a", "hex"));
  });
  const result = await checker({ url: "https://example.com/design.png", formatCode: "other_link" });
  assert.equal(result.ok, true);
  assert.equal(result.access, "public_view");
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(seen.map((r) => r.method), ["HEAD", "GET"]);
});

test("body cap and timeout cannot claim public access or hang the checker", async (t) => {
  const { checker } = await mockChecker(t, (req, res) => {
    if (req.url === "/slow") return;
    res.setHeader("Content-Type", "text/html");
    res.end("a".repeat(100_000));
  }, { timeoutMs: 80 });
  const capped = await checker({ url: "https://example.com/large", formatCode: "other_link" });
  assert.equal(capped.access, "unknown");
  assert.match(capped.message, /large/i);
  const timed = await checker({ url: "https://example.com/slow", formatCode: "other_link" });
  assert.equal(timed.ok, false);
  assert.match(timed.message, /timed out/i);
  const dns = createArtworkLinkChecker({ timeoutMs: 30, lookup: () => new Promise(() => {}) });
  const result = await dns({ url: "https://example.com", formatCode: "other_link" });
  assert.match(result.message, /timed out/i);
});

test("DNS is rechecked at each redirect and again before a GET fallback", async (t) => {
  for (const redirect of [true, false]) {
    let resolutions = 0;
    const { checker, seen } = await mockChecker(t, (_req, res) => {
      if (redirect) res.writeHead(302, { Location: "/second" });
      else res.setHeader("Content-Type", "text/html");
      res.end();
    }, { lookup: async () => [{ address: ++resolutions === 1 ? "93.184.216.34" : "10.1.1.1", family: 4 }] });
    await assert.rejects(checker({ url: "https://example.com/first", formatCode: "other_link" }), { code: "unsafe_artwork_url" });
    assert.equal(seen.length, 1);
  }
});

test("redirect URLs retain scheme and credential validation", async (t) => {
  for (const location of ["file:///etc/passwd", "https://user:password@example.com/private", "http://127.0.0.1/private"]) {
    const { checker, seen } = await mockChecker(t, (_req, res) => { res.writeHead(302, { Location: location }); res.end(); });
    await assert.rejects(checker({ url: "https://example.com/design", formatCode: "other_link" }), { code: location.startsWith("http://127") ? "unsafe_artwork_url" : "invalid_artwork_link" });
    assert.equal(seen.length, 1);
  }
});

test("403 is inconclusive, 401 requires sign-in, and mislabeled HTML is not public artwork", async (t) => {
  const { checker } = await mockChecker(t, (req, res) => {
    const status = req.url === "/401" ? 401 : req.url === "/403" ? 403 : 200;
    res.writeHead(status, { "Content-Type": "image/png" });
    res.end("<html>Login</html>");
  });
  for (const [path, access] of [["/401", "sign_in_required"], ["/403", "unknown"], ["/mislabeled", "unknown"]]) {
    const result = await checker({ url: `https://example.com${path}`, formatCode: "other_link" });
    assert.equal(result.ok, false);
    assert.equal(result.access, access);
  }
});

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/artwork-links/responses.json', import.meta.url)));
const publicHtml = readFileSync(new URL('./fixtures/artwork-links/canva-public.html', import.meta.url));
function serveFixture(res, fixture, body) {
  res.writeHead(fixture.status, fixture.headers);
  res.end(body ?? fixture.body ?? '');
}

test('captured Canva viewer HTML proves viewing even over the cap; unsupported shells do not', async (t) => {
  const { checker, seen } = await mockChecker(t, (req, res) => {
    const body = req.url.includes('unsupported')
      ? readFileSync(new URL('./fixtures/artwork-links/canva-unsupported.html', import.meta.url))
      : Buffer.concat([publicHtml, Buffer.alloc(90_000, 32)]);
    serveFixture(res, fixtures.public, body);
  });
  for (const suffix of ['view', 'edit']) {
    const result = await checker({ url: fixtures.public.url.replace(/view$/, suffix), formatCode: 'canva_link' });
    assert.equal(result.access, 'public_view'); // Viewer evidence never grants edit rights.
    assert.equal(result.ok, true);
  }
  for (const url of [fixtures.public.url.replace('DAF9RMb6BGM', 'DIFFERENT'), `${fixtures.public.url}?unsupported=1`, fixtures.public.url.replace('www.canva.com', 'canva.com.evil.example')]) {
    assert.equal((await checker({ url, formatCode: 'other_link' })).access, 'unknown');
  }
  assert.match(seen[0].headers['user-agent'], /Mozilla\/5\.0/);
  assert.equal(seen[0].headers.accept, 'text/html');
  assert.ok(seen.every((r) => !r.headers.cookie && !r.headers.authorization));
});

test('Canva login redirects, 404 and challenge responses retain honest verdicts', async (t) => {
  for (const [kind, access] of [['loginRedirect', 'sign_in_required'], ['missing', 'not_found'], ['challenge', 'unknown']]) {
    const { checker } = await mockChecker(t, (req, res) => serveFixture(res, req.url.startsWith('/login') ? fixtures.login : fixtures[kind]));
    const result = await checker({ url: fixtures.public.url, formatCode: 'canva_link' });
    assert.equal(result.access, access);
    assert.equal(result.ok, false);
  }
  const { checker } = await mockChecker(t, (_req, res) => serveFixture(res, { ...fixtures.challenge, status: 200 }, publicHtml));
  assert.equal((await checker({ url: fixtures.public.url, formatCode: 'canva_link' })).access, 'unknown');
});

test('Canva short links resolve to a canonical Canva design without trusting the short hostname', async (t) => {
  const { checker } = await mockChecker(t, (req, res) => serveFixture(res, req.headers.host === 'canva.link' ? fixtures.short : fixtures.public, req.headers.host === 'canva.link' ? '' : publicHtml));
  for (const formatCode of ['canva_link', 'other_link']) {
    const result = await checker({ url: 'https://canva.link/demo', formatCode });
    assert.equal(result.access, 'public_view');
    assert.equal(result.provider, 'canva');
    assert.equal(result.url, fixtures.public.url);
    assert.equal(result.formatCode, 'canva_link');
  }
  const malicious = await mockChecker(t, (_req, res) => { res.writeHead(302, { Location: 'https://127.0.0.1/private' }); res.end(); });
  await assert.rejects(malicious.checker({ url: 'https://canva.link/demo', formatCode: 'canva_link' }), { code: 'unsafe_artwork_url' });
  const loop = await mockChecker(t, (_req, res) => serveFixture(res, { status: 302, headers: { location: '/loop' } }));
  assert.equal((await loop.checker({ url: 'https://canva.link/demo', formatCode: 'canva_link' })).access, 'unknown');
  assert.equal(loop.seen.length, 4);
});

test('large public artwork uses retained leading magic bytes without accepting MIME alone', async (t) => {
  for (const file of fixtures.files) {
    for (const valid of [true, false]) {
      const { checker } = await mockChecker(t, (_req, res) => {
        res.setHeader('Content-Type', file.type);
        res.end(Buffer.concat([valid ? Buffer.from(file.hex, 'hex') : Buffer.from('<html>'), Buffer.alloc(100_000)]));
      });
      const result = await checker({ url: 'https://example.com/file', formatCode: 'other_link' });
      assert.equal(result.access, valid ? 'public_view' : 'unknown', file.type);
    }
  }
});

test('registry URL codes enforce provider domains and preserve other_link fallback', async (t) => {
  const { checker } = await mockChecker(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html></html>'); });
  for (const [formatCode, host] of [['google_drive', 'drive.google.com'], ['google_drive', 'docs.google.com'], ['dropbox', 'www.dropbox.com'], ['dropbox', 'dl.dropboxusercontent.com'], ['we_transfer', 'wetransfer.com'], ['we_transfer', 'we.tl']]) {
    const url = `https://${host}/file`;
    const result = await checker({ url, formatCode });
    assert.equal(result.provider, formatCode);
    assert.equal(result.access, 'unknown');
    assert.deepEqual(validateArtworkLinks([{ formatCode, url }], [{ code: formatCode, inputKind: 'url', active: true }]), [{ formatCode, url }]);
    assert.throws(() => validateArtworkLinks([{ formatCode, url }], []), { code: 'artwork_link_format_not_accepted' });
    await assert.rejects(checker({ url: `https://${host}.evil.example/file`, formatCode }), { code: 'invalid_artwork_link' });
    assert.equal((await checker({ url, formatCode: 'other_link' })).provider, formatCode);
  }
});

test('cart normalization saves the resolved design as canva_link and rechecks listing formats', async (t) => {
  const { checker } = await mockChecker(t, (req, res) => serveFixture(res, req.headers.host === 'canva.link' ? fixtures.short : fixtures.public, req.headers.host === 'canva.link' ? '' : publicHtml));
  const formats = [{ code: 'canva_link', inputKind: 'url', active: true }];
  const links = [{ formatCode: 'other_link', url: 'https://canva.link/demo' }];
  assert.deepEqual(await resolveArtworkLinks(links, formats, checker), [{ formatCode: 'canva_link', url: fixtures.public.url }]);
  await assert.rejects(resolveArtworkLinks(links, [{ code: 'other_link', inputKind: 'url' }], checker), { code: 'artwork_link_format_not_accepted' });
  for (const location of ['https://example.com/file', 'http://www.canva.com/design/ABC/view', '/loop']) {
    const local = await mockChecker(t, (_req, res) => serveFixture(res, { status: 302, headers: { location } }));
    await assert.rejects(resolveArtworkLinks(links, formats, local.checker), { code: 'artwork_link_unresolved' });
  }
  assert.throws(() => validateArtworkLinks([{ formatCode: 'canva_link', url: 'https://canva.link/demo' }], formats), { code: 'artwork_link_unresolved' });
});

test('a short private Canva link retains its design URL, never the login destination', async (t) => {
  const { checker } = await mockChecker(t, (req, res) => {
    const fixture = req.headers.host === 'canva.link' ? fixtures.short
      : req.url.startsWith('/login') ? fixtures.login : fixtures.loginRedirect;
    serveFixture(res, fixture);
  });
  const result = await checker({ formatCode: 'canva_link', url: 'https://canva.link/private' });
  assert.equal(result.access, 'sign_in_required');
  assert.equal(result.url, fixtures.public.url);
  assert.equal(result.formatCode, 'canva_link');
});

test('Canva evidence beyond the 64 KiB prefix is never inspected', async (t) => {
  const { checker } = await mockChecker(t, (_req, res) => serveFixture(res, fixtures.public, Buffer.concat([Buffer.alloc(65_536, 32), publicHtml])));
  assert.equal((await checker({ url: fixtures.public.url, formatCode: 'canva_link' })).access, 'unknown');
});
