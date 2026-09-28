import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { identityHasMembership } from "./authorization-context.js";
import { tooManyRequests } from "./support-rate-limit.js";

const MAX_URL = 2000;
const URL_FORMATS = new Set(["canva_link", "google_drive", "dropbox", "we_transfer", "other_link"]);
const CANVA_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
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
  if (!link || typeof link !== "object" || Array.isArray(link) || !URL_FORMATS.has(link.formatCode)) {
    fail(400, code, "Choose a supported design-link format.");
  }
  const url = parseUrl(link.url, { httpsOnly, code });
  const expectedProvider = link.formatCode === "canva_link" ? "canva" : link.formatCode;
  if (link.formatCode !== "other_link" && providerFor(url) !== expectedProvider) {
    fail(400, code, "The link must use the selected provider's domain.");
  }
  return url;
}

export function hasShortArtworkLinks(links) {
  return Array.isArray(links) && links.some((link) => {
    try { return hostOf(new URL(link?.url)) === "canva.link"; } catch { return false; }
  });
}

// Only short links need network work on cart writes. Call before the domain
// transaction; the route revalidates the resulting links against current formats.
export async function resolveArtworkLinks(links, acceptedFormats, checker = checkLink) {
  const normalized = validateArtworkLinks(links, acceptedFormats, { allowShortLinks: true });
  for (const link of normalized) {
    if (hostOf(new URL(link.url)) !== "canva.link") continue;
    const checked = await checker(link);
    const resolved = parseUrl(checked.url, { httpsOnly: true, code: "artwork_link_unresolved" });
    if (!canvaDesignId(resolved)) {
      fail(400, "artwork_link_unresolved", "Could not resolve the Canva short link. Paste its full canva.com design link.");
    }
    link.url = resolved.href;
  }
  return validateArtworkLinks(normalized, acceptedFormats);
}

export function validateArtworkLinks(links, acceptedFormats, { allowShortLinks = false } = {}) {
  if (!Array.isArray(links) || links.length > 3) fail(400, "invalid_artwork_links", "Send an array of at most three artwork links.");
  return links.map((link) => {
    const url = linkInput(link, { httpsOnly: true, code: "invalid_artwork_links" });
    if (hostOf(url) === "canva.link") {
      if (!allowShortLinks) fail(400, "artwork_link_unresolved", "Paste the resolved canva.com design link.");
      link = { ...link, formatCode: "canva_link" };
    }
    if (!(acceptedFormats || []).some((format) => format.code === link.formatCode && format.inputKind === "url" && format.active !== false)) {
      fail(400, "artwork_link_format_not_accepted", "This listing does not accept that design-link format.");
    }
    return { formatCode: link.formatCode, url: link.url };
  });
}

function providerFor(url) {
  const host = hostOf(url);
  if (onDomain(host, "canva.com") || host === "canva.link") return "canva";
  if (["drive.google.com", "docs.google.com"].includes(host)) return "google_drive";
  if (onDomain(host, "dropbox.com") || onDomain(host, "dropboxusercontent.com")) return "dropbox";
  if (onDomain(host, "wetransfer.com") || host === "we.tl") return "we_transfer";
  if (onDomain(host, "figma.com")) return "figma";
  return "other";
}
function canvaDesignId(url) {
  return onDomain(hostOf(url), "canva.com")
    ? /^\/design\/([a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)?\/(?:view|edit)\/?$/.exec(url.pathname)?.[1] : null;
}
function canvaPublicPage(url, response, html) {
  const designId = canvaDesignId(url);
  // Captured Canva viewer bootstrap identifies the actual design being served.
  // Metadata or a 200 shell alone also appears on unsupported/error pages.
  return designId && response.status === 200
    && !response.headers["cf-mitigated"]
    && /text\/html/i.test(response.headers["content-type"] || "")
    && html.includes(`"page":{"X":"VIEWER","Bj":{"A":{"A":"${designId}"`);
}
function driveFileId(url) {
  if (hostOf(url) === "drive.google.com") {
    return /^\/file\/d\/([a-zA-Z0-9_-]+)\/(?:view|preview)\/?$/.exec(url.pathname)?.[1]
      || (url.pathname === "/uc" ? url.searchParams.get("id") : null);
  }
  return hostOf(url) === "drive.usercontent.google.com" && url.pathname === "/download"
    ? url.searchParams.get("id") : null;
}
function pageMarkup(html) {
  // An unterminated script at the body cap is still script, not visible copy.
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
}
function visiblePageText(html) {
  return pageMarkup(html).replace(/<[^>]*>/g, " ").replace(/&(?:#39|apos|#x27);|’/gi, "'")
    .replace(/&(?:nbsp|#160);/gi, " ").replace(/\s+/g, " ");
}
function drivePageAccess(url, html) {
  const id = driveFileId(url);
  if (!id || hostOf(url) !== "drive.google.com") return null;
  // Captured anonymous Drive viewer config. Bind it to this file, not just a
  // generic title/OG tag; config appears before itemJson and within the cap.
  const config = /window\.viewerData\s*=\s*\{config:\s*\{([^}]+)\}/.exec(html)?.[1];
  if (config?.includes(`'id': '${id}'`)) {
    if (/'isItemTrashed':\s*true\b/.test(config)) return "not_found";
    if (/'isItemTrashed':\s*false\b/.test(config)) return "public_view";
  }
  const text = visiblePageText(html);
  if (/\b(?:you need (?:access|permission)|you must sign in to access this content)\b/i.test(text)) return "sign_in_required";
  if (/\b(?:the file you have requested does not exist|file (?:has been|was) deleted)\b/i.test(text)) return "not_found";
  return null;
}
function canvaMissingPage(url, html) {
  if (!canvaDesignId(url)) return false;
  // Inspect rendered error copy, never script translations or design data.
  html = pageMarkup(html);
  const text = visiblePageText(html);
  return /\b(?:this|the) design (?:does(?:n't| not) exist|(?:has been|was) deleted|could(?:n't| not) be found)\b/i.test(text)
    || /<(?:title|h[1-6])\b[^>]*>\s*(?:page|design) not found(?:\s*[-–—]\s*Canva)?\s*<\//i.test(html);
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
        headers: {
          "User-Agent": onDomain(hostOf(url), "canva.com") ? CANVA_USER_AGENT : "GRIDGO-Artwork-Link-Check/1.0",
          Accept: onDomain(hostOf(url), "canva.com") ? "text/html" : "text/html,application/pdf,image/*;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
        },
      }, (res) => {
        const response = { status: res.statusCode, headers: res.headers, bytes: Buffer.alloc(0), capped: false };
        if (method === "HEAD" || REDIRECTS.has(res.statusCode)) { resolve(response); res.destroy(); return; }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          const remaining = MAX_BYTES - size;
          chunks.push(chunk.subarray(0, remaining));
          size += chunk.length;
          if (size > MAX_BYTES) {
            resolve({ ...response, bytes: Buffer.concat(chunks, MAX_BYTES), capped: true });
            res.destroy();
            return;
          }
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
    let provider = providerFor(url);
    const shortCanva = hostOf(url) === "canva.link";
    let canonicalUrl = null;
    const verdict = (reachable, status, access, message) => ({
      ...result(provider, reachable, status, access, message),
      url: canonicalUrl || link.url,
      formatCode: canonicalUrl ? "canva_link" : link.formatCode,
    });
    const controller = new AbortController();
    let timer;
    let status = null;
    let reachable = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("link_timeout")); }, timeoutMs);
    });
    const run = async () => {
      // Drive needs body evidence. Avoid spending the same deadline on HEAD
      // at both /uc and its usercontent redirect before fetching any bytes.
      let method = driveFileId(url) ? "GET" : "HEAD";
      let redirects = 0;
      let sawLogin = false;
      while (true) {
        const address = await addressFor(url);
        controller.signal.throwIfAborted();
        const response = await read(url, address, method, controller.signal);
        status = response.status;
        reachable = true;
        if (shortCanva && canvaDesignId(url)) { canonicalUrl = url.href; provider = "canva"; }
        else if (shortCanva && !canonicalUrl) provider = providerFor(url);
        sawLogin ||= loginUrl(url);
        if (response.headers["cf-mitigated"] === "challenge") return verdict(true, status, "unknown", "The provider challenged the link check. Open it yourself to check sharing access.");
        if (REDIRECTS.has(status)) {
          if (!response.headers.location || redirects >= 3) return verdict(reachable, status, "unknown", "The link has too many redirects or an incomplete redirect. Try a direct sharing link.");
          let next;
          try { next = new URL(response.headers.location, url).href; } catch { return verdict(reachable, status, "unknown", "The link returned an invalid redirect."); }
          url = parseUrl(next);
          // A Google sign-in redirect is already conclusive. Validate its DNS
          // like every other hop, but do not spend the budget fetching login.
          if (provider === "google_drive" && hostOf(url) === "accounts.google.com") {
            await addressFor(url);
            controller.signal.throwIfAborted();
            return verdict(true, status, "sign_in_required", "This link requires sign-in. Enable public link sharing or upload the artwork.");
          }
          redirects++;
          continue;
        }
        if (status === 404 || status === 410) return verdict(true, status, "not_found", "That design could not be found. Check the sharing link.");
        if (status === 401 || sawLogin) return verdict(true, status, "sign_in_required", "This link requires sign-in. Enable public link sharing or upload the artwork.");
        if (method === "HEAD" && (status >= 200 && status < 300 || [403, 405, 501].includes(status))) { method = "GET"; continue; }
        const html = response.bytes.toString("utf8");
        if (/text\/html/i.test(response.headers["content-type"] || "") && /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html)) {
          return verdict(true, status, "sign_in_required", "This page asks for sign-in. Enable public link sharing or upload the artwork.");
        }
        if (status >= 200 && status < 300 && publicArtworkBytes(response)) {
          return verdict(true, status, "public_view", "Anyone with the link can view this artwork. Edit permission is not verified.");
        }
        if (canvaPublicPage(url, response, html)) {
          return verdict(true, status, "public_view", "Anyone with the link can view this Canva design. Edit permission is not verified.");
        }
        if (/text\/html/i.test(response.headers["content-type"] || "")) {
          const driveAccess = drivePageAccess(url, html);
          if (driveAccess === "sign_in_required") return verdict(true, status, driveAccess, "This file requires access. Enable public link sharing or upload the artwork.");
          if (driveAccess === "not_found" || canvaMissingPage(url, html)) return verdict(true, status, "not_found", "That design could not be found. Check the sharing link.");
          if (status === 200 && driveAccess === "public_view") return verdict(true, status, driveAccess, "Anyone with the link can view this Google Drive file. Edit permission is not verified.");
        }
        if (response.capped) return verdict(true, status, "unknown", "The page is too large to check safely. Open it yourself to check sharing access.");
        const canvaEdit = provider === "canva" && /^\/design\/[^/]+\/edit\/?$/i.test(url.pathname);
        return verdict(true, status, "unknown", canvaEdit
          ? "This is a Canva edit link, but edit permission cannot be verified without signing in. Check its sharing settings."
          : "The server responded, but public viewing and edit permission could not be verified. Check sharing settings or upload the artwork.");
      }
    };
    try { return await Promise.race([run(), timeout]); }
    catch (error) {
      if (error.code === "unsafe_artwork_url" || error.code === "invalid_artwork_link") throw error;
      return verdict(reachable, status, "unknown", controller.signal.aborted ? "The link check timed out. Try again or upload the artwork." : "The link could not be checked. Check the address or try again.");
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

const checkLink = createArtworkLinkChecker();
export async function checkArtworkLinkForUser(userId, link) {
  if (tooManyRequests(`artwork-link:${userId}`, 10, 60_000)) fail(429, "artwork_link_rate_limited", "Wait a minute before checking more links.");
  return checkLink(link);
}
export async function routeArtworkLinkCheck({ req, url, user, readBody }) {
  if (req.method !== "POST" || url.pathname !== "/artwork/link-check") return null;
  if (!user) fail(401, "unauthorized", "Sign in to check an artwork link.");
  if (!identityHasMembership(user, "client")) fail(403, "forbidden", "Only clients can check artwork links.");
  return { status: 200, body: await checkArtworkLinkForUser(user.id, await readBody(req)) };
}
