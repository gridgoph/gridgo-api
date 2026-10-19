import { identityHasMembership } from './authorization-context.js';
import { AvailabilityError, validateShopSchedule, defaultShopSchedule, isOpenAt, addOpeningMilliseconds } from './availability.js';
import { operatingHours, validateOperatingHours } from './operating-hours.js';
import { productionDayMinutes } from './production-days.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const fail = (status, code, message) => { throw new AvailabilityError(status, code, message); };
const local = (at, offset = 480) => new Date(Date.parse(at) + offset * 60000);
const baseSchedule = profile => {
  const { extension, ...base } = profile?.schedule || defaultShopSchedule();
  return structuredClone(base);
};

export function shopHoursStatus(profile, settings, at = new Date().toISOString()) {
  const schedule = profile?.schedule || defaultShopSchedule();
  try { validateShopSchedule(schedule); }
  catch (error) {
    if (!(error instanceof AvailabilityError)) throw error;
    return { timeZone: 'Asia/Manila', schedule: baseSchedule(profile), version: profile?.version || 1,
      temporarilyClosed: Boolean(profile?.isClosed), isOpenNow: false, nextOpeningAt: null,
      todayExtension: null, dispatchNotice: null, calendarAvailable: false,
      features: { multipleWindows: false, overnightWindows: false, riderShifts: false, hubDays: false } };
  }
  const today = local(at, schedule.utcOffsetMinutes).toISOString().slice(0, 10);
  const todayExtension = schedule.extension?.day === today ? structuredClone(schedule.extension) : null;
  let nextOpeningAt = null;
  if (!profile?.isClosed) {
    try { nextOpeningAt = addOpeningMilliseconds(schedule, at, 0); }
    catch (error) { if (error.code !== 'shop_never_open') throw error; }
  }
  const platform = operatingHours(settings).schedule;
  const extensionEnd = todayExtension && new Date(Date.parse(`${today}T00:00:00Z`) + (todayExtension.closesMinute - schedule.utcOffsetMinutes) * 60000 - 1).toISOString();
  return { timeZone: 'Asia/Manila', schedule: baseSchedule(profile), version: profile?.version || 1,
    temporarilyClosed: Boolean(profile?.isClosed), isOpenNow: !profile?.isClosed && isOpenAt(schedule, at),
    nextOpeningAt, todayExtension, calendarAvailable: true,
    dispatchNotice: extensionEnd && (!isOpenAt(platform, at) || !isOpenAt(platform, extensionEnd))
      ? 'review_and_dispatch_in_next_working_window' : null,
    features: { multipleWindows: false, overnightWindows: false, riderShifts: false, hubDays: false } };
}

/** Prospective only. Never opt a historical order in during reads or migration. */
export function snapshotShopClock(store, order) {
  if (order.shopClockVersion !== 1 || !order.supplierId || order.shopClock?.supplierId === order.supplierId) return;
  const profile = store.supplierProfiles?.find(row => row.userId === order.supplierId);
  order.shopClock = { version: 1, supplierId: order.supplierId, profileVersion: profile?.version || 1,
    schedule: structuredClone(profile?.schedule || defaultShopSchedule()) };
}
export const shopSlaClock = order => order.shopClock ?? order.operatingClock;

function validateBase(schedule) {
  if (!schedule || Object.keys(schedule).some(key => !['utcOffsetMinutes', 'week', 'closures'].includes(key))) {
    fail(400, 'invalid_shop_hours', 'Send only the base weekly hours and closure dates; declare extensions separately.');
  }
  try { validateOperatingHours({ timeZone: 'Asia/Manila', schedule, artworkReviewMinutes: 1, priorityDispatchCutoffMinute: 0 }, { requireDispatchWindow: false }); }
  catch { fail(400, 'invalid_shop_hours', 'Use one daytime window per open day in Asia/Manila and valid closure dates (at most 90 days).'); }
  productionDayMinutes(schedule);
}

function extensionFor(schedule, input, at) {
  const date = local(at), day = date.toISOString().slice(0, 10);
  const row = schedule.week.find(row => row.weekday === date.getUTCDay());
  const closesMinute = input?.closesMinute;
  const closesAt = Date.parse(`${day}T00:00:00Z`) + (closesMinute - 480) * 60000;
  if (!input || Object.keys(input).some(key => !['day', 'closesMinute'].includes(key)) || (input.day != null && input.day !== day)
    || !row || schedule.closures?.some(row => row.startDay <= day && row.endDay >= day)
    || !Number.isSafeInteger(closesMinute) || closesMinute >= 1440 || closesMinute <= row.closesMinute
    || closesAt - Date.parse(at) < 30 * 60000) {
    fail(400, 'invalid_shop_extension', 'Extend an open day only, until before midnight today and at least 30 minutes from now.');
  }
  const currentMinute = Math.ceil((Date.parse(at) - Date.parse(`${day}T00:00:00Z`)) / 60000) + 480;
  return { day, opensMinute: schedule.extension?.day === day ? schedule.extension.opensMinute : Math.max(row.closesMinute, currentMinute), closesMinute };
}

export async function routeShopHours({ req, url, store, user, readBody, now, id, audit }) {
  const own = url.pathname === '/me/shop-hours';
  const staff = /^\/ops\/shops(?:\/([^/]+))?\/hours$/.exec(url.pathname);
  if (!own && !staff) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to view shop hours.');
  if (own ? !identityHasMembership(user, 'supplier') : !identityHasMembership(user, 'ops_admin') && !identityHasMembership(user, 'super_admin')) fail(403, 'forbidden', 'This shop-hours action is not available to your role.');
  if (!['GET', 'PATCH'].includes(req.method) || (!own && !staff[1] && req.method !== 'GET')) fail(405, 'method_not_allowed', 'Use GET or PATCH.');
  const at = now();
  if (staff && !staff[1]) return { status: 200, body: { shops: (store.supplierProfiles || []).map(profile => ({
    supplierId: profile.userId, shopName: profile.shopName, hours: shopHoursStatus(profile, store.settings, at) })) } };
  const profile = (store.supplierProfiles || []).find(row => row.userId === (own ? user.id : staff[1]));
  if (!profile) fail(404, 'supplier_profile_not_found', 'Shop profile not found.');
  if (req.method === 'GET') return { status: 200, body: { hours: shopHoursStatus(profile, store.settings, at) } };
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_shop_hours', 'Send a shop-hours object.');
  if (body.expectedVersion !== (profile.version || 1)) fail(409, 'supplier_profile_stale', 'Refresh this shop before saving its hours.');
  if (Object.keys(body).some(key => !['expectedVersion', 'schedule', 'temporarilyClosed', 'extension', 'reason'].includes(key))) fail(400, 'invalid_shop_hours', 'Unknown shop-hours field.');
  if (!own && (Object.hasOwn(body, 'schedule') || Object.hasOwn(body, 'extension'))) fail(403, 'forbidden', 'Staff may change the temporary closure only.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if ((!own && !reason) || reason.length > 2000) fail(400, 'reason_required', 'Give a reason of at most 2,000 characters.');
  if (Object.hasOwn(body, 'temporarilyClosed') && typeof body.temporarilyClosed !== 'boolean') fail(400, 'invalid_shop_hours', 'Temporarily closed must be true or false.');
  const schedule = structuredClone(profile.schedule || defaultShopSchedule());
  if (Object.hasOwn(body, 'schedule')) {
    validateBase(body.schedule);
    Object.assign(schedule, structuredClone(body.schedule));
    // The old declaration belonged to the previous base hours. Committed orders retain theirs.
    delete schedule.extension;
  }
  if (Object.hasOwn(body, 'extension')) {
    if (body.extension === null) delete schedule.extension;
    else {
      if (body.temporarilyClosed ?? profile.isClosed) fail(409, 'shop_closed', 'Reopen the shop before extending its hours.');
      schedule.extension = extensionFor(schedule, body.extension, at);
    }
  }
  profile.schedule = schedule;
  if (Object.hasOwn(body, 'temporarilyClosed')) profile.isClosed = body.temporarilyClosed;
  profile.version = (profile.version || 1) + 1;
  profile.updatedAt = at;
  const actor = { id: user.id, name: user.name, role: own ? 'supplier' : identityHasMembership(user, 'super_admin') ? 'super_admin' : 'ops_admin' };
  audit(store, { actor, action: 'supplier_hours.update', entityType: 'supplier_profile', entityId: profile.userId, reason: reason || null });
  const recipients = [{ userId: profile.userId, role: 'supplier' }, ...privilegedAdminMemberships(store)];
  for (const recipient of recipients) {
    (store.notifications ||= []).push({ id: id('ntf'), userId: recipient.userId, appRole: recipient.role,
      type: 'supplier_hours_updated', title: 'Shop hours updated', body: 'The shop hours or temporary closure changed. Existing order commitments remain unchanged.',
      at, read: false, occurrenceKey: `shop-hours:${profile.userId}:${profile.version}` });
  }
  queueInvalidate(store, { resource: 'catalog', supplierId: profile.userId, userIds: [profile.userId] });
  queueInvalidate(store, { resource: 'notifications', userIds: recipients.map(row => row.userId) });
  return { status: 200, mutated: true, body: { hours: shopHoursStatus(profile, store.settings, at) } };
}
