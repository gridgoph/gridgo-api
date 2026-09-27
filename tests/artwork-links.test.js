import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createArtworkLinkChecker } from "../src/artwork-links.js";

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
  assert.ok(seen.every((r) => r.headers["user-agent"] === "GRIDGO-Artwork-Link-Check/1.0" && !r.headers.authorization && !r.headers.cookie));
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
