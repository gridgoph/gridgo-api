import { voucherFail as fail } from './vouchers.js';
import { isReviewData } from './review-data.js';

const FIELDS = ['handoffReminderVersion', 'remindedClient', 'clientAgreedToPhoto', 'packagePhotoFileId'];
/** Validate before any delivery/OTP mutation; an omitted capability is the released-app path. */
export function validateDeliveryReminder(store, order, body) {
  const modern = FIELDS.some(key => Object.hasOwn(body, key));
  if (modern && body.handoffReminderVersion !== 1) fail(400, 'unsupported_handoff_reminder_version');
  if (order.fulfillmentMode !== 'delivery') {
    if (FIELDS.slice(1).some(key => Object.hasOwn(body, key))) fail(409, 'delivery_reminder_not_available');
    return null; // Hub drop-offs do not involve the client.
  }
  if (!modern) return { protocolVersion: 0, remindedClient: false, clientAgreedToPhoto: false, packagePhotoFileId: null };
  if (body.remindedClient !== true) fail(400, 'client_reminder_required');
  if (Object.hasOwn(body, 'clientAgreedToPhoto') && typeof body.clientAgreedToPhoto !== 'boolean') fail(400, 'invalid_photo_consent');
  const photo = body.packagePhotoFileId;
  if (photo != null && (typeof photo !== 'string' || !photo)) fail(400, 'invalid_package_photo');
  if (photo && body.clientAgreedToPhoto !== true) fail(400, 'package_photo_consent_required');
  if (photo && !(store.files || []).some(file => file.fileId === photo && file.ownerId === order.riderId
    && file.purpose === 'delivery_package_photo' && file.state === 'ready' && file.objectKey
    && ['image/jpeg', 'image/png', 'image/webp'].includes(file.detectedContentType)
    && file.references?.some(ref => ref.type === 'order' && ref.id === order.id))) fail(400, 'package_photo_required');
  return { protocolVersion: 1, remindedClient: true, clientAgreedToPhoto: body.clientAgreedToPhoto === true, packagePhotoFileId: photo ?? null };
}

/** ISO week of the local calendar date. Manila is UTC+08:00 year-round. */
export function manilaWeek(at) {
  const local = new Date(Date.parse(at) + 8 * 3600000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() || 7) + 1);
  const weekStart = day.toISOString().slice(0, 10);
  const thursday = new Date(day); thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return { week: `${year}-W${String(week).padStart(2, '0')}`, weekStart };
}

export function reminderReport(store, params, inRange) {
  const groups = new Map();
  const reminders = new Map((store.deliveryReminders || []).map(row => [row.orderId, row]));
  const surveys = new Map((store.orderSurveys || []).map(row => [row.orderId, row]));
  const shareTimes = new Map();
  for (const tap of store.orderShareTaps || []) {
    if (tap.action !== 'share') continue;
    shareTimes.set(tap.orderId, Math.max(shareTimes.get(tap.orderId) || 0, Date.parse(tap.createdAt)));
  }
  for (const order of store.orders) {
    if (order.fulfillmentMode !== 'delivery' || isReviewData(order)
      || isReviewData(store.users.find(user => user.id === order.clientId))) continue;
    const row = reminders.get(order.id);
    const deliveredAt = row?.deliveredAt || order.deliveryEvidence?.recordedAt;
    const riderId = row?.riderId || order.deliveryEvidence?.riderId;
    if (!deliveredAt || !riderId || !inRange(deliveredAt) || params.has('riderId') && params.get('riderId') !== riderId) continue;
    const week = manilaWeek(deliveredAt), key = `${riderId}:${week.week}`;
    if (!groups.has(key)) groups.set(key, { riderId, ...week, deliveries: 0, remindedDeliveries: 0,
      legacyDeliveries: 0, surveySubmittedDeliveries: 0, shareTappedDeliveries: 0, surveyAndShareDeliveries: 0 });
    const group = groups.get(key);
    group.deliveries++;
    if (!row || row.protocolVersion === 0) group.legacyDeliveries++;
    if (!row?.remindedClient) continue;
    group.remindedDeliveries++;
    const surveyed = Date.parse(surveys.get(order.id)?.submittedAt) >= Date.parse(deliveredAt);
    const shared = shareTimes.get(order.id) >= Date.parse(deliveredAt);
    if (surveyed) group.surveySubmittedDeliveries++;
    if (shared) group.shareTappedDeliveries++;
    if (surveyed && shared) group.surveyAndShareDeliveries++;
  }
  return [...groups.values()].map(group => ({ ...group, reminderRate: group.remindedDeliveries / group.deliveries }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.riderId.localeCompare(b.riderId));
}
