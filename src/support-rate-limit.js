import net from "node:net";

const windows = new Map();
const SWEEP_AT = 5000;

function sweep(now) {
  for (const [key, stamps] of windows) {
    // Every limiter window is well under a day; anything older is dead weight.
    if (!stamps.length || now - stamps[stamps.length - 1] > 24 * 60 * 60 * 1000) windows.delete(key);
  }
}

export function tooManyRequests(key, limit, windowMs) {
  const now = Date.now();
  if (windows.size > SWEEP_AT) sweep(now);
  const recent = (windows.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return true;
  }
  recent.push(now);
  windows.set(key, recent);
  return false;
}

export function clientKey(ip, forwarded) {
  const forwardedFirst = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "";
  return forwardedFirst || ip || "unknown";
}

/**
 * Who sent this request, for rate limiting. Production sits behind Cloudflare,
 * which sets `CF-Connecting-IP` to the visitor; the edge Caddy replaces
 * X-Forwarded-For with its own peer, so without the Cloudflare header every
 * visitor would share one bucket. Only a well-formed IP is accepted.
 */
export function requestClientKey(req) {
  const cf = req.headers?.["cf-connecting-ip"];
  if (typeof cf === "string" && net.isIP(cf.trim())) return cf.trim();
  return clientKey(req.socket?.remoteAddress, req.headers?.["x-forwarded-for"]);
}
