const windows = new Map();

export function tooManyRequests(key, limit, windowMs) {
  const now = Date.now();
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
