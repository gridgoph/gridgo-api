import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { identityHasMembership } from "./authorization-context.js";
import { tooManyRequests } from "./support-rate-limit.js";

const MAX_URL = 2000;
const MAX_BYTES = 64 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const denied4 = new net.BlockList();
// Non-global/special-purpose space (IANA), multicast, reserved, plus Azure's
// platform virtual IP. IPv4-mapped/NAT64 IPv6 is refused by the global allowlist.
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) denied4.addSubnet(ip, prefix, "ipv4");
denied4.addAddress("168.63.129.16", "ipv4");
const global6 = new net.BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new net.BlockList();
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) denied6.addSubnet(ip, prefix, "ipv6");

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function hostOf(url) { return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, ""); }
function onDomain(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function publicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !denied4.check(address, "ipv4")
    : family === 6 && global6.check(address, "ipv6") && !denied6.check(address, "ipv6");
}
function parseUrl(value, { httpsOnly = false, code = "invalid_artwork_link" } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_URL || /[\s\\\x00-\x1f\x7f]/u.test(value)) {
    fail(400, code, "Use a complete link of at most 2,000 characters without spaces.");
  }
  let url;
  try { url = new URL(value); } catch { fail(400, code, "Use a complete web link."); }
  if (!(httpsOnly ? ["https:"] : ["http:", "https:"]).includes(url.protocol) || url.username || url.password || !url.hostname) {
    fail(400, code, httpsOnly ? "Use an HTTPS link without a username or password." : "Use an HTTP or HTTPS link without a username or password.");
  }
  return url;
}
function linkInput(link, { httpsOnly = false, code = "invalid_artwork_link" } = {}) {
  if (!link || typeof link !== "object" || Array.isArray(link) || !["canva_link", "other_link"].includes(link.formatCode)) {
    fail(400, code, "Choose canva_link or other_link.");
  }
  const url = parseUrl(link.url, { httpsOnly, code });
  if (link.formatCode === "canva_link" && !onDomain(hostOf(url), "canva.com")) {
    fail(400, code, "A Canva link must be on canva.com.");
  }
  return url;
}

export function validateArtworkLinks(links, acceptedFormats) {
  if (!Array.isArray(links) || links.length > 3) fail(400, "invalid_artwork_links", "Send an array of at most three artwork links.");
  return links.map((link) => {
    linkInput(link, { httpsOnly: true, code: "invalid_artwork_links" });
    if (!(acceptedFormats || []).some((format) => format.code === link.formatCode && format.inputKind === "url" && format.active !== false)) {
      fail(400, "artwork_link_format_not_accepted", "This listing does not accept that design-link format.");
    }
    return { formatCode: link.formatCode, url: link.url };
  });
}

function providerFor(url) {
  const host = hostOf(url);
  if (onDomain(host, "canva.com")) return "canva";
  if (["drive.google.com", "docs.google.com"].includes(host)) return "google_drive";
  if (onDomain(host, "dropbox.com") || onDomain(host, "dropboxusercontent.com")) return "dropbox";
  if (onDomain(host, "figma.com")) return "figma";
  return "other";
}
function loginUrl(url) {
  return hostOf(url) === "accounts.google.com" || /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up)(?:\/|$)/i.test(url.pathname);
}
function result(provider, reachable, httpStatus, access, message) {
  return { ok: ["public_view", "public_edit"].includes(access), reachable, httpStatus, provider, access, message };
}
function publicArtworkBytes(response) {
  const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const bytes = response.bytes;
  return (type === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-")
    || (type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    || (type === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (type === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
}

// The resolved, validated IP is supplied directly to the socket lookup. There
// is no second DNS lookup for an attacker to rebind, no proxy or shared agent,
// and HTTPS keeps the original hostname for certificate verification and SNI.
export function createArtworkLinkChecker({
  lookup = dns.lookup,
  request = (url, options, callback) => (url.protocol === "https:" ? https : http).request(url, options, callback),
  timeoutMs = 5000,
} = {}) {
  async function addressFor(url) {
    const host = hostOf(url);
    if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".") && !net.isIP(host)) {
      fail(400, "unsafe_artwork_url", "Use a public internet link, not a local or private address.");
    }
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) {
      fail(400, "unsafe_artwork_url", "Use a public internet link, not a local or private address.");
    }
    return addresses[0];
  }
  function read(url, address, method, signal) {
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method, signal, agent: false, maxHeaderSize: 8192,
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: { "User-Agent": "GRIDGO-Artwork-Link-Check/1.0", Accept: "text/html,application/pdf,image/*;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" },
      }, (res) => {
        const response = { status: res.statusCode, headers: res.headers, bytes: Buffer.alloc(0), capped: false };
        if (method === "HEAD" || REDIRECTS.has(res.statusCode)) { resolve(response); res.destroy(); return; }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) { resolve({ ...response, capped: true }); res.destroy(); return; }
          chunks.push(chunk);
        });
        res.once("end", () => resolve({ ...response, bytes: Buffer.concat(chunks) }));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.once("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("protocol_upgrade")); });
      req.end();
    });
  }
  return async function check(link) {
    let url = linkInput(link);
    const provider = providerFor(url);
    const controller = new AbortController();
    let timer;
    let status = null;
    let reachable = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("link_timeout")); }, timeoutMs);
    });
    const run = async () => {
      let method = "HEAD";
      let redirects = 0;
      let sawLogin = false;
      while (true) {
        const address = await addressFor(url);
        controller.signal.throwIfAborted();
        const response = await read(url, address, method, controller.signal);
        status = response.status;
        reachable = true;
        sawLogin ||= loginUrl(url);
        if (REDIRECTS.has(status)) {
          if (!response.headers.location || redirects >= 3) return result(provider, reachable, status, "unknown", "The link has too many redirects or an incomplete redirect. Try a direct sharing link.");
          let next;
          try { next = new URL(response.headers.location, url).href; } catch { return result(provider, reachable, status, "unknown", "The link returned an invalid redirect."); }
          url = parseUrl(next);
          redirects++;
          continue;
        }
        if (status === 404 || status === 410) return result(provider, true, status, "not_found", "That design could not be found. Check the sharing link.");
        if (status === 401 || sawLogin) return result(provider, true, status, "sign_in_required", "This link requires sign-in. Enable public link sharing or upload the artwork.");
        if (method === "HEAD" && (status >= 200 && status < 300 || [403, 405, 501].includes(status))) { method = "GET"; continue; }
        if (response.capped) return result(provider, true, status, "unknown", "The page is too large to check safely. Open it yourself to check sharing access.");
        const html = response.bytes.toString("utf8");
        if (/text\/html/i.test(response.headers["content-type"] || "") && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html)) {
          return result(provider, true, status, "sign_in_required", "This page asks for sign-in. Enable public link sharing or upload the artwork.");
        }
        if (status >= 200 && status < 300 && publicArtworkBytes(response)) {
          return result(provider, true, status, "public_view", "Anyone with the link can view this artwork. Edit permission is not verified.");
        }
        const canvaEdit = provider === "canva" && /^\/design\/[^/]+\/edit\/?$/i.test(url.pathname);
        return result(provider, true, status, "unknown", canvaEdit
          ? "This is a Canva edit link, but edit permission cannot be verified without signing in. Check its sharing settings."
          : "The server responded, but public viewing and edit permission could not be verified. Check sharing settings or upload the artwork.");
      }
    };
    try { return await Promise.race([run(), timeout]); }
    catch (error) {
      if (error.code === "unsafe_artwork_url" || error.code === "invalid_artwork_link") throw error;
      return result(provider, reachable, status, "unknown", controller.signal.aborted ? "The link check timed out. Try again or upload the artwork." : "The link could not be checked. Check the address or try again.");
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

const checkLink = createArtworkLinkChecker();
export async function routeArtworkLinkCheck({ req, url, user, readBody }) {
  if (req.method !== "POST" || url.pathname !== "/artwork/link-check") return null;
  if (!user) fail(401, "unauthorized", "Sign in to check an artwork link.");
  if (!identityHasMembership(user, "client")) fail(403, "forbidden", "Only clients can check artwork links.");
  if (tooManyRequests(`artwork-link:${user.id}`, 10, 60_000)) fail(429, "artwork_link_rate_limited", "Wait a minute before checking more links.");
  return { status: 200, body: await checkLink(await readBody(req)) };
}
