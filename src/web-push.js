import crypto from 'node:crypto';
import webpush from 'web-push';
import { hasRole } from './notifications.js';

// Subscription URLs are caller input. Only browser push services may receive
// server requests; no redirects, arbitrary ports or credential-bearing URLs.
export function validPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port
      && (u.hostname === 'fcm.googleapis.com'
        || u.hostname === 'updates.push.services.mozilla.com'
        || u.hostname === 'web.push.apple.com'
        || u.hostname.endsWith('.notify.windows.com'));
  } catch { return false; }
}
function keyBytes(value, length) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').length === length;
}
export function validSubscription(subscription) {
  if (!validPushEndpoint(subscription?.endpoint)
    || !keyBytes(subscription?.keys?.auth, 16)
    || !keyBytes(subscription?.keys?.p256dh, 65)) return false;
  try {
    crypto.ECDH.convertKey(Buffer.from(subscription.keys.p256dh, 'base64url'), 'prime256v1');
    return true;
  } catch { return false; }
}

export async function loadVapid(database, env = process.env) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  if (publicKey || privateKey || subject) {
    if (!publicKey || !privateKey || !subject) throw new Error('web_push_configuration_invalid');
    const key = crypto.createECDH('prime256v1');
    key.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (key.getPublicKey().toString('base64url') !== publicKey) throw new Error('web_push_configuration_invalid');
    webpush.getVapidHeaders('https://web.push.apple.com', subject, publicKey, privateKey, 'aes128gcm');
    return { publicKey, privateKey, subject };
  }
  return database.transaction(async () => {
    const existing = (await database.query('SELECT public_key, private_key, subject FROM web_push_vapid WHERE singleton')).rows[0];
    if (existing) return { publicKey: existing.public_key, privateKey: existing.private_key, subject: existing.subject };
    const keys = { ...webpush.generateVAPIDKeys(), subject: 'https://gridgo-api.talasora.com' };
    await database.query('INSERT INTO web_push_vapid(public_key, private_key, subject) VALUES ($1,$2,$3)', [keys.publicKey, keys.privateKey, keys.subject]);
    return keys;
  });
}

export async function listWebSubscriptions(database) {
  return (await database.query('SELECT * FROM web_push_subscriptions')).rows.map(row => ({
    id: row.id, userId: row.user_id, appRole: row.app_role,
    endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

export async function unregisterWebSubscription(database, userId, endpoint) {
  return database.query('DELETE FROM web_push_subscriptions WHERE user_id=$1 AND endpoint=$2', [userId, endpoint]);
}

export async function routeWebPush({ database, store, user, method, pathname, body, userAgent, delivery }) {
  if (!user) return { status: 401, body: { error: 'unauthorized' } };
  if (!hasRole(store, user.id, 'supplier')) return { status: 403, body: { error: 'forbidden' } };
  if (method === 'GET' && pathname === '/web-push/public-key') {
    return delivery.configured
      ? { status: 200, body: { publicKey: delivery.publicKey } }
      : { status: 503, body: { error: 'web_push_unavailable' } };
  }
  if (method === 'POST' && pathname === '/web-push/unsubscribe') {
    if (!validPushEndpoint(body?.endpoint)) return { status: 400, body: { error: 'invalid_web_push_endpoint' } };
    await unregisterWebSubscription(database, user.id, body.endpoint);
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && pathname === '/web-push/subscribe') {
    if (!delivery.configured) return { status: 503, body: { error: 'web_push_unavailable' } };
    if (!validSubscription(body?.subscription)) return { status: 400, body: { error: 'invalid_web_push_subscription' } };
    const s = body.subscription;
    // A new id on replacement invalidates queued work, including when a shared
    // browser switches away and then back to the same account (ABA ownership).
    const refreshed = await database.query(`UPDATE web_push_subscriptions SET user_agent=$5, updated_at=now()
      WHERE endpoint=$1 AND user_id=$2 AND p256dh=$3 AND auth=$4 RETURNING id`,
      [s.endpoint, user.id, s.keys.p256dh, s.keys.auth, String(userAgent || '').slice(0, 512)]);
    if (refreshed.rowCount) return { status: 200, body: { ok: true } };
    await database.query('DELETE FROM web_push_subscriptions WHERE endpoint=$1', [s.endpoint]);
    await database.query(`INSERT INTO web_push_subscriptions(id, endpoint, p256dh, auth, user_id, user_agent)
      VALUES ($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(), s.endpoint, s.keys.p256dh, s.keys.auth, user.id, String(userAgent || '').slice(0, 512)]);
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: 'not_found' } };
}

export function createWebPushDelivery({ vapid, sendNotification = webpush.sendNotification.bind(webpush) } = {}) {
  return {
    configured: Boolean(vapid), publicKey: vapid?.publicKey,
    async send(message, [subscription]) {
      if (!vapid || !validSubscription(subscription)) return [{ ok: false, code: 'web_push_configuration_invalid' }];
      // Derive navigation only from allowlisted data, never an input URL.
      const url = message.data?.orderId
        ? `/supplier/jobs/${encodeURIComponent(message.data.orderId)}` : '/supplier';
      const payload = JSON.stringify({ title: message.title, body: message.body, data: message.data, url });
      try {
        await sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload,
          { vapidDetails: vapid, TTL: 3600, timeout: 10000, urgency: 'normal' });
        return [{ ok: true, prune: false, code: null }];
      } catch (error) {
        const status = Number(error?.statusCode);
        return [{ ok: false, prune: status === 404 || status === 410,
          code: Number.isInteger(status) && status >= 100 && status <= 599 ? `web_push_${status}` : 'web_push_transport_error' }];
      }
    },
  };
}
