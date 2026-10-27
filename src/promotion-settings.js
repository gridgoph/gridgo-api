import { voucherFail as fail } from './vouchers.js';

export function defaultPromotionSettings() {
  return {
    founding: { amountMinor: 20000, slots: 30, startsAt: '2026-10-26T16:00:00.000Z', endsAt: '2026-11-08T15:59:59.000Z', enabled: true },
    friendPass: { amountMinor: 10000, perFounder: 1, total: 20, upgradeAt: '2026-11-01T15:59:59.000Z', enabled: true },
    budgetCapMinor: 900000,
    rewards: { surveyMinor: 1500, missionMinor: 1500, inviteMinor: 1500 },
  };
}
export function promotionSettings(store) {
  const defaults = defaultPromotionSettings(), saved = store.promotionSettings?.find(row => row.id === 'launch')?.settings;
  return { ...defaults, ...saved, founding: { ...defaults.founding, ...saved?.founding },
    friendPass: { ...defaults.friendPass, ...saved?.friendPass }, rewards: { ...defaults.rewards, ...saved?.rewards } };
}
export const promotionVersion = store => store.promotionSettings?.find(row => row.id === 'launch')?.version ?? 1;
export function updatedPromotionSettings(store, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== promotionVersion(store)) {
    throw Object.assign(new Error('settings_version_conflict'), { status: 409, code: 'settings_version_conflict', details: { version: promotionVersion(store) } });
  }
  const next = promotionSettings(store);
  for (const key of Object.keys(body)) {
    if (key === 'expectedVersion' || key === 'reason') continue;
    if (!Object.hasOwn(next, key)) fail(400, 'invalid_promotion_settings');
    if (key === 'budgetCapMinor') next[key] = body[key];
    else {
      if (!body[key] || typeof body[key] !== 'object' || Array.isArray(body[key]) || Object.keys(body[key]).some(field => !Object.hasOwn(next[key], field))) fail(400, 'invalid_promotion_settings');
      Object.assign(next[key], body[key]);
    }
  }
  for (const [value, min, max] of [[next.founding.amountMinor, 1], [next.friendPass.amountMinor, 1], [next.budgetCapMinor, 0],
    [next.rewards.surveyMinor, 1], [next.rewards.missionMinor, 1], [next.rewards.inviteMinor, 1, Math.floor(Number.MAX_SAFE_INTEGER / 2)],
    [next.founding.slots, 0, 1000000], [next.friendPass.total, 0, 1000000], [next.friendPass.perFounder, 0, 1000000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > (max ?? Number.MAX_SAFE_INTEGER)) fail(400, 'invalid_promotion_settings');
  }
  for (const [section, field] of [['founding', 'startsAt'], ['founding', 'endsAt'], ['friendPass', 'upgradeAt']]) {
    const value = next[section][field];
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'invalid_promotion_settings');
    next[section][field] = new Date(value).toISOString();
  }
  if (Date.parse(next.founding.startsAt) >= Date.parse(next.founding.endsAt)
    || Date.parse(next.friendPass.upgradeAt) < Date.parse(next.founding.startsAt)
    || Date.parse(next.friendPass.upgradeAt) >= Date.parse(next.founding.endsAt)
    || typeof next.founding.enabled !== 'boolean' || typeof next.friendPass.enabled !== 'boolean') fail(400, 'invalid_promotion_settings');
  return next;
}
