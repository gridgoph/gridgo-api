import { authorizationContextFor } from "./authorization-context.js";
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 3_600_000;
const PUBLIC_FIELDS = ['id', 'name', 'startDate', 'endDate', 'demandLevel', 'message'];

function fail(status, code, details = {}) {
  throw Object.assign(new Error(code), { status, code, details });
}

export function manilaDate(at) {
  return new Date(Date.parse(at) + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function bannerFor(window, today) {
  const startDate = shiftDate(window.startDate, -42);
  const endDate = shiftDate(window.startDate, -28);
  return { startDate, endDate, active: today >= startDate && today <= endDate };
}

function publicWindow(window, today) {
  return {
    ...Object.fromEntries(PUBLIC_FIELDS.map(key => [key, window[key]])),
    status: today < window.startDate ? 'upcoming' : today <= window.endDate ? 'current' : 'past',
    banner: bannerFor(window, today),
  };
}

export function projectSeasonWindows(windows, at) {
  const today = manilaDate(at);
  const projected = [...windows].filter(w => w.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
    .map(w => publicWindow(w, today));
  return { timeZone: 'Asia/Manila', today, awarenessOnly: true, windows: projected, banners: projected.filter(w => w.banner.active) };
}

export function seasonPushSettings(store) {
  const value = store.settings?.seasonWindowPush;
  return { enabled: value?.enabled === true, version: value?.version || 1 };
}

function membership(store, userId, role) {
  return (store.userRoleMemberships || []).some(m => m.userId === userId && m.role === role);
}

function activeClient(store, userId) {
  const user = (store.users || []).find(u => u.id === userId);
  return Boolean(user && !['suspended', 'removed'].includes(user.accountStatus) && membership(store, userId, 'client'));
}

function eligibleDevices(store) {
  return (store.deviceTokens || []).filter(d => d.userId && (!d.appRole || d.appRole === 'client') && activeClient(store, d.userId));
}

function due(window, today) {
  return !window.noticeQueuedAt && bannerFor(window, today).active;
}

export function seasonPushDryRun(store, at) {
  const today = manilaDate(at);
  const devices = eligibleDevices(store);
  const clients = new Set(devices.map(d => d.userId));
  return {
    ...seasonPushSettings(store), timeZone: 'Asia/Manila', today,
    eligibleClients: clients.size, eligibleDevices: devices.length,
    windows: [...(store.seasonWindows || [])].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)).map(w => ({
      id: w.id, name: w.name, banner: bannerFor(w, today), noticeQueuedAt: w.noticeQueuedAt ?? null,
      due: due(w, today), wouldNotifyClients: due(w, today) ? clients.size : 0,
      wouldNotifyDevices: due(w, today) ? devices.length : 0,
    })),
  };
}

/** Also checked by the outbox before delivery, so disabling cancels pending notices. */
export function seasonPushAllowed(store, device, notification, at = new Date().toISOString()) {
  const window = (store.seasonWindows || []).find(w => w.id === notification.seasonWindowId);
  return seasonPushSettings(store).enabled && Boolean(window?.noticeQueuedAt)
    && bannerFor(window, manilaDate(at)).active
    && activeClient(store, device.userId)
    && (!device.appRole || device.appRole === 'client');
}

/** Called inside the domain transaction; save() owns inbox/outbox/realtime persistence. */
export function applySeasonNotices(store, { at, createId, audit }) {
  if (!seasonPushSettings(store).enabled) return [];
  const today = manilaDate(at);
  const recipients = [...new Set(eligibleDevices(store).map(d => d.userId))];
  const queued = [];
  for (const window of store.seasonWindows || []) {
    if (!due(window, today)) continue;
    window.noticeQueuedAt = at;
    window.updatedAt = at;
    window.version += 1;
    for (const userId of recipients) {
      store.notifications.push({ id: createId('ntf'), userId, type: 'season_window', appRole: 'client', seasonWindowId: window.id, title: window.name, body: window.message, at, read: false });
    }
    staffNotice(store, { createId, at, type: 'season_window_notice_queued', title: 'Season notice queued', body: `${window.name}: ${recipients.length} clients.` });
    audit(store, { actor: { role: 'system' }, action: 'season_window.notice_queued', entityType: 'season_window', entityId: window.id, detail: { notifiedClients: recipients.length, startDate: window.startDate } });
    queued.push(window.id);
  }
  return queued;
}

function staffNotice(store, { createId, at, type, title, body }) {
  for (const m of privilegedAdminMemberships(store)) {
    store.notifications.push({ id: createId('ntf'), userId: m.userId, type, appRole: m.role, title, body, at, read: false, push: false });
  }
  queueInvalidate(store, { resource: 'settings' });
}

function requireSuper(store, user) {
  if (!user) fail(401, 'unauthorized');
  const selected = authorizationContextFor(user);
  if (!membership(store, user.id, 'super_admin') || (selected && !selected.memberships.some(m => m.role === 'super_admin'))) fail(403, 'forbidden');
}

function record(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_season_window');
  return body;
}

function validateWindow(body) {
  const result = {};
  for (const [key, max] of [['name', 120], ['message', 500]]) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > max) fail(400, 'invalid_season_window', { field: key });
    result[key] = body[key].trim();
  }
  for (const key of ['startDate', 'endDate']) {
    const value = body[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(400, 'invalid_season_window', { field: key });
    result[key] = value;
  }
  if (result.endDate < result.startDate) fail(400, 'invalid_season_window', { field: 'endDate' });
  if (!['Normal', 'Busy', 'Peak'].includes(body.demandLevel)) fail(400, 'invalid_season_window', { field: 'demandLevel' });
  result.demandLevel = body.demandLevel;
  return result;
}

function checkVersion(body, version) {
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== version) fail(409, 'season_window_version_conflict', { version });
}

export async function routeSeasonWindows({ req, url, store, user, readBody, now, createId, audit }) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/season-windows') {
    return { status: 200, body: projectSeasonWindows(store.seasonWindows || [], now()), mutated: false };
  }
  if (pathname !== '/admin/season-windows' && !/^\/admin\/season-windows\/[^/]+$/.test(pathname)) return null;
  requireSuper(store, user);
  const at = now();
  if (pathname === '/admin/season-windows/push-settings') {
    if (req.method === 'GET') return { status: 200, body: seasonPushSettings(store), mutated: false };
    if (req.method !== 'PATCH') return null;
    const body = record(await readBody(req));
    const previous = seasonPushSettings(store);
    checkVersion(body, previous.version);
    if (typeof body.enabled !== 'boolean') fail(400, 'invalid_season_push_setting');
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) fail(400, 'season_push_reason_required');
    const current = { enabled: body.enabled, version: previous.version + 1 };
    store.settings = { ...store.settings, seasonWindowPush: current };
    audit(store, { actor: user, action: 'season_window.push_setting_updated', entityType: 'settings', entityId: 'season_window_push', detail: { previous, current }, reason: body.reason.trim() });
    staffNotice(store, { createId, at, type: 'season_window_push_setting_updated', title: 'Season push setting updated', body: current.enabled ? 'Season notices enabled.' : 'Season notices disabled.' });
    return { status: 200, body: current, mutated: true };
  }
  if (pathname === '/admin/season-windows/push-dry-run') {
    return req.method === 'POST' ? { status: 200, body: seasonPushDryRun(store, at), mutated: false } : null;
  }
  const windows = store.seasonWindows || (store.seasonWindows = []);
  const adminWindow = w => ({ ...publicWindow(w, manilaDate(at)), version: w.version, noticeQueuedAt: w.noticeQueuedAt ?? null, createdAt: w.createdAt, updatedAt: w.updatedAt });
  if (pathname === '/admin/season-windows') {
    if (req.method === 'GET') return { status: 200, body: { ...projectSeasonWindows(windows, at), windows: [...windows].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)).map(adminWindow) }, mutated: false };
    if (req.method !== 'POST') return null;
    const values = validateWindow(record(await readBody(req)));
    const window = { ...values, id: createId('sea'), version: 1, noticeQueuedAt: null, createdAt: at, updatedAt: at };
    windows.push(window);
    audit(store, { actor: user, action: 'season_window.created', entityType: 'season_window', entityId: window.id, detail: values });
    staffNotice(store, { createId, at, type: 'season_window_created', title: 'Season window created', body: window.name });
    return { status: 201, body: { window: adminWindow(window) }, mutated: true };
  }
  if (!['PATCH', 'DELETE'].includes(req.method)) return null;
  const window = windows.find(w => w.id === pathname.split('/')[3]);
  if (!window) fail(404, 'season_window_not_found');
  const body = record(await readBody(req));
  checkVersion(body, window.version);
  const previous = structuredClone(window);
  if (req.method === 'DELETE') {
    store.seasonWindows = windows.filter(w => w.id !== window.id);
    audit(store, { actor: user, action: 'season_window.deleted', entityType: 'season_window', entityId: window.id, detail: { previous } });
    staffNotice(store, { createId, at, type: 'season_window_deleted', title: 'Season window deleted', body: window.name });
    return { status: 200, body: { ok: true }, mutated: true };
  }
  const values = validateWindow({ ...window, ...body });
  Object.assign(window, values, { version: window.version + 1, updatedAt: at });
  audit(store, { actor: user, action: 'season_window.updated', entityType: 'season_window', entityId: window.id, detail: { previous, current: structuredClone(window) } });
  staffNotice(store, { createId, at, type: 'season_window_updated', title: 'Season window updated', body: window.name });
  return { status: 200, body: { window: adminWindow(window) }, mutated: true };
}
