import { defaultShopSchedule, isOpenAt, weeklyWindows } from './availability.js';
import { operatingHours } from './operating-hours.js';

export const NIGHT_MODES = ['off', 'until_21', 'until_23', 'all_night'];
const DAY = 86400000;
export const manilaDay = at => new Date(Date.parse(at) + 480 * 60000).toISOString().slice(0, 10);
const midnight = day => Date.parse(`${day}T00:00:00+08:00`);
export const shopPaused = (profile, at) => Date.parse(profile?.availability?.pausedUntil) > Date.parse(at);
const closedOn = (schedule, day) => schedule.closures?.some(c => c.startDay <= day && c.endDay >= day);

/** Separate night windows leave published production calendars unchanged. */
export function nightWindow(profile, at) {
  const mode = profile?.availability?.nightJobs || 'off';
  if (!NIGHT_MODES.includes(mode) || mode === 'off') return null;
  const schedule = profile.schedule || defaultShopSchedule();
  if (schedule.utcOffsetMinutes !== 480) return null;
  const now = Date.parse(at), today = midnight(manilaDay(at));
  for (const startDay of [today - DAY, today]) {
    const day = manilaDay(new Date(startDay).toISOString());
    if (closedOn(schedule, day)) continue;
    const windows = weeklyWindows(schedule, new Date(`${day}T00:00:00Z`).getUTCDay());
    if (!windows.length) continue;
    const close = Math.max(...windows.map(w => w.closesMinute), schedule.extension?.day === day ? schedule.extension.closesMinute : 0);
    const tomorrow = manilaDay(new Date(startDay + DAY).toISOString());
    const nextWindows = weeklyWindows(schedule, new Date(`${tomorrow}T00:00:00Z`).getUTCDay());
    const until = mode === 'until_21' ? 1260 : mode === 'until_23' ? 1380
      : 1440 + (nextWindows.length ? Math.min(...nextWindows.map(w => w.opensMinute)) : 480);
    const start = startDay + close * 60000, end = startDay + until * 60000;
    if (now >= start && now < end && !closedOn(schedule, manilaDay(at)) && !isOpenAt(schedule, at)) {
      return { night: day, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
    }
  }
  return null;
}

export function expressAvailability(profile, settings, at, fulfillmentMode = 'pickup') {
  if (profile?.isClosed || shopPaused(profile, at) || profile?.expressEnabled === false) return null;
  if(profile?.homePrinter) {
    if(profile.homePrinter.onboardingLiveAt&&profile.schedule&&!isOpenAt(profile.schedule,at))return null;
    const deliveryAvailable=isOpenAt(operatingHours(settings).schedule,at);
    if(!profile.homePrinter.online || fulfillmentMode==='pickup'&&!profile.pickupAvailable || fulfillmentMode==='delivery'&&!deliveryAvailable)return null;
    return {nightWindow:{startsAt:at,endsAt:new Date(Date.parse(at)+DAY).toISOString(),home:true},deliveryAvailable};
  }
  const night = nightWindow(profile, at);
  if (!night && !isOpenAt(profile?.schedule || defaultShopSchedule(), at)) return null;
  const deliveryAvailable = isOpenAt(operatingHours(settings).schedule, at);
  if (fulfillmentMode === 'delivery' && !deliveryAvailable) return null;
  return { nightWindow: night, deliveryAvailable };
}
