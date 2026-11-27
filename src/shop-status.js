import { shopHoursStatus } from './shop-hours.js';
import { NIGHT_MODES, nightWindow, shopPaused, manilaDay, expressAvailability } from './shop-availability.js';
import { defaultShopSchedule, weeklyWindows } from './availability.js';
import { isShopStaff } from './shop-team.js';
import { queueInvalidate } from './notifications.js';
import { notifyAdmins } from './domain-events.js';
import {shopMoneySettings} from './shop-money-settings.js';
import {shopMoneyPaused} from './shop-money-policy.js';
import {shopJobPerformance} from './shop-job-policy.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export function myShopStatus(store, profile, at) {
  const day = manilaDay(at), schedule = profile.schedule || defaultShopSchedule();
  const todayHours = schedule.closures?.some(c => c.startDay <= day && c.endDay >= day) ? []
    : weeklyWindows(schedule, new Date(`${day}T00:00:00Z`).getUTCDay());
  if (todayHours.length && schedule.extension?.day === day) {
    todayHours.push({ opensMinute: schedule.extension.opensMinute, closesMinute: schedule.extension.closesMinute });
  }
  const hours = shopHoursStatus(profile, store.settings, at);
  const moneyPaused=shopMoneyPaused(store,profile.userId,at);
  const isOpenNow = !moneyPaused&&(hours.isOpenNow || Boolean(expressAvailability(profile, store.settings, at)?.nightWindow));
  const pauseOpensAt = profile.availability?.pausedUntil&&shopPaused(profile, at) && expressAvailability(profile, store.settings, profile.availability.pausedUntil)
    ? profile.availability.pausedUntil : null;
  return { supplierId: profile.userId, shopName: profile.shopName, version: profile.version || 1,
    hours, todayHours, isOpenNow, nextOpeningAt: isOpenNow ? at : pauseOpensAt || hours.nextOpeningAt,
    expressEnabled: profile.expressEnabled !== false,
    nightJobs: profile.availability?.nightJobs || 'off', nightWindow: nightWindow(profile, at),
    printerDemandPings: profile.availability?.printerDemandPings !== false,
    moneyPaused,performance:shopJobPerformance(store,profile.userId,at),openUntil:Date.parse(profile.availability?.openUntil)>Date.parse(at)?profile.availability.openUntil:null,
    openOptions:{minutes:shopMoneySettings(store.settings).openMinutes,midnight:true},
    pausedUntil: shopPaused(profile, at) ? profile.availability.pausedUntil : null };
}

export async function routeShopStatus({ req, url, store, user, readBody, now, id, audit }) {
  if (url.pathname !== '/me/shop-status') return null;
  if (!user) fail(401, 'unauthorized');
  if (user.role !== 'supplier') fail(403, 'forbidden');
  if (!['GET', 'PATCH'].includes(req.method)) fail(405, 'method_not_allowed');
  const profile = store.supplierProfiles.find(p => p.userId === user.id);
  if (!profile) fail(404, 'shop_not_found');
  const at = now();
  if (req.method === 'GET') return { status: 200, body: myShopStatus(store, profile, at) };
  if (isShopStaff(user)) fail(403, 'shop_owner_required');
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['expectedVersion', 'temporarilyClosed', 'expressEnabled', 'nightJobs', 'printerDemandPings', 'pause','missedJobs','openFor'].includes(k))
    || !Number.isSafeInteger(body.expectedVersion)
    || ['temporarilyClosed', 'expressEnabled', 'printerDemandPings'].some(k => Object.hasOwn(body, k) && typeof body[k] !== 'boolean')
    || (Object.hasOwn(body, 'nightJobs') && !NIGHT_MODES.includes(body.nightJobs))
    || (Object.hasOwn(body, 'pause') && !['one_hour', 'today', null].includes(body.pause))
    ||(Object.hasOwn(body,'missedJobs')&&!['resume','closed_today'].includes(body.missedJobs))
    ||(Object.hasOwn(body,'openFor')&&body.openFor!=='midnight'&&!shopMoneySettings(store.settings).openMinutes.includes(body.openFor))) fail(400, 'invalid_shop_status');
  if(body.openFor!==undefined&&body.missedJobs==='closed_today')fail(400,'invalid_shop_status');
  if (body.expectedVersion !== (profile.version || 1)) fail(409, 'shop_profile_stale');
  const before = myShopStatus(store, profile, at), availability = { ...profile.availability };
  if(body.missedJobs) {
    availability.missedJobPause={...availability.missedJobPause,active:false};availability.missedJobsResetAt=at;
    if(body.missedJobs==='closed_today')availability.pausedUntil=new Date(Date.parse(`${manilaDay(at)}T00:00:00+08:00`)+86400000).toISOString();
  }
  if(Object.hasOwn(body,'temporarilyClosed')){delete availability.openUntil;delete availability.openRestoreClosed;}
  if(body.openFor!==undefined) {
    if(profile.homePrinter)profile.homePrinter.online=true;
    availability.missedJobPause={...availability.missedJobPause,active:false};availability.missedJobsResetAt=at;availability.pausedUntil=null;
    availability.openRestoreClosed=profile.isClosed===true||availability.openRestoreClosed===true;
    availability.openUntil=new Date(body.openFor==='midnight'?Date.parse(`${manilaDay(at)}T00:00:00+08:00`)+86400000:Date.parse(at)+body.openFor*60000).toISOString();
    profile.isClosed=false;
  }
  if (Object.hasOwn(body, 'temporarilyClosed')) profile.isClosed = body.temporarilyClosed;
  if (Object.hasOwn(body, 'expressEnabled')) profile.expressEnabled = body.expressEnabled;
  for (const key of ['nightJobs', 'printerDemandPings']) if (Object.hasOwn(body, key)) availability[key] = body[key];
  if (Object.hasOwn(body, 'pause')) availability.pausedUntil = body.pause === null ? null : new Date(body.pause === 'one_hour'
    ? Date.parse(at) + 3600000 : Date.parse(`${manilaDay(at)}T00:00:00+08:00`) + 86400000).toISOString();
  profile.availability = availability;
  profile.version = (profile.version || 1) + 1;
  profile.updatedAt = at;
  const after = myShopStatus(store, profile, at);
  audit(store, { actor: user, action: 'shop.status_updated', entityType: 'supplier_profile', entityId: user.id, before, after });
  notifyAdmins(store, 'ops_shop_status_updated', 'Shop availability changed', null, `${user.id}:${profile.version}`, { createId: id, at });
  queueInvalidate(store, { resource: 'catalog', userIds: [user.id] });
  return { status: 200, body: after, mutated: true };
}
