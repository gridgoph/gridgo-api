/**
 * One-tap messages around pickup (docs/ORDER_TRACKING_API.md#quick-messages).
 * They are ordinary order-chat messages with fixed text, so chat history,
 * contact masking, reports and notifications stay exactly as for typed text.
 */

const READY = 'ready_for_dispatch';
const fail = code => { throw Object.assign(new Error(code), { status: 400, code }); };

const CLIENT = {
  there_in_10: { text: "I'll be there in 10 mins" },
  keep_until: { text: 'Please keep it until {time}', time: true },
  im_here: { text: "I'm here · Ania na ko" },
  running_late: { text: 'Running late' },
  thank_you: { text: 'Thank you!' },
};
const SHOP = {
  ready_at_counter: { text: 'Your print is ready at the counter.' },
  see_you_soon: { text: 'See you soon!' },
  thank_you: { text: 'Thank you!' },
};

const pickedUp = order => Boolean(order.expressOrder?.pickedUpAt) || ['issue_window_open', 'delivered', 'completed'].includes(order.state);
const ready = order => order.state === READY || order.state === 'awaiting_collection';

/** Codes this party may send now. Pickup-only: deliveries talk through the rider chat. */
export function quickMessageCodes(order, party) {
  if (order?.fulfillmentMode !== 'pickup' || order.orderType !== 'express') return [];
  const onMyWay = Boolean(order.expressOrder?.onMyWay);
  if (party === 'client') {
    if (pickedUp(order)) return ['thank_you'];
    if (!ready(order)) return [];
    return onMyWay ? ['im_here', 'running_late', 'thank_you'] : ['there_in_10', 'keep_until'];
  }
  if (party === 'supplier') {
    if (pickedUp(order)) return ['thank_you'];
    return ready(order) ? ['ready_at_counter', 'see_you_soon'] : [];
  }
  return [];
}

export function quickMessages(order, party) {
  const table = party === 'client' ? CLIENT : SHOP;
  return quickMessageCodes(order, party).map(code => ({ code, text: table[code].text, ...(table[code].time ? { needsTime: true } : {}) }));
}

/** Validated fixed text for `{quickMessage:{code, time?}}`; time is local "HH:MM". */
export function quickMessageText(order, party, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['code', 'time'].includes(key))) fail('invalid_quick_message');
  if (!quickMessageCodes(order, party).includes(value.code)) {
    throw Object.assign(new Error('quick_message_unavailable'), { status: 409, code: 'quick_message_unavailable' });
  }
  const entry = (party === 'client' ? CLIENT : SHOP)[value.code];
  if (!entry.time) {
    if (value.time !== undefined) fail('invalid_quick_message');
    return entry.text;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.time || '');
  if (!match) fail('invalid_quick_message');
  const hour = Number(match[1]), minute = match[2];
  return entry.text.replace('{time}', `${hour % 12 || 12}${minute === '00' ? '' : `:${minute}`} ${hour < 12 ? 'AM' : 'PM'}`);
}
