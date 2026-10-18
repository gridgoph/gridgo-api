import { approvedRole, canAccessOrder } from './notifications.js';

const ACCEPTED_STATES = new Set(['supplier_accepted', 'payment_authorized', 'production', 'supplier_self_qc', 'ready_for_dispatch', 'rider_assigned', 'picked_up',
  'out_for_delivery', 'awaiting_collection', 'issue_window_open', 'completed', 'payout_released']);
const TERMINAL = new Set(['cancelled', 'completed', 'payout_released']);
export { CLIENT_SHOP_CHAT_PURPOSE, CLIENT_SHOP_CHAT_MAX_BYTES, CLIENT_SHOP_CHAT_TYPES } from './chat-attachment-policy.js';
export const CHAT_REMINDER = 'Price, specification and deadline changes require a formal change request. Chat messages do not change the order.';
export const CHAT_WARNING = 'Contact details are hidden. Keep communication and payment within GRIDGO. This thread has been flagged for Operations review.';
export const isChatStaff = user => ['ops_admin', 'super_admin'].includes(user?.role);

export function clientShopChatWindow(order, at = new Date().toISOString()) {
  const closesAt = order?.issueWindowExpiresAt ?? null;
  if (TERMINAL.has(order?.state) || (closesAt && Date.parse(at) >= Date.parse(closesAt))
      || (order?.shopRecovery && order.shopRecovery.status !== 'accepted')) return { status: 'read_only', closesAt };
  if (!order?.supplierId) return { status: 'unavailable', closesAt };
  const acceptance = order.shopAcceptance;
  const accepted = acceptance
    ? acceptance.status === 'accepted' && acceptance.supplierId === order.supplierId
    : ACCEPTED_STATES.has(order.state);
  return { status: accepted ? 'open' : 'unavailable', closesAt };
}

export function clientShopChatParty(user, order, store) {
  if (!store || !user || !order || !approvedRole(store, user?.id, user?.role)) return null;
  if (isChatStaff(user)) return 'gridgo';
  if (user.role === 'client' && order.clientId === user.id) return 'client';
  if (user.role === 'supplier' && order.supplierId === user.id && canAccessOrder(store, user.id, order, { role: 'supplier' })) return 'supplier';
  return null;
}

export function clientShopChatProjection(order, user, store, at) {
  if (!clientShopChatParty(user, order, store)) return null;
  return { ...clientShopChatWindow(order, at), participants: ['Client', 'Print shop', 'GRIDGO'], reminder: CHAT_REMINDER };
}

export function canReadClientShopChatFile(user, store, reference) {
  if (reference?.type !== 'client_shop_chat_message') return false;
  const order = (store.orders || []).find(row => row.id === reference.orderId);
  if (!order || !approvedRole(store, user?.id, user?.role)) return false;
  if (isChatStaff(user)) return true;
  if (user.role === 'client') return order.clientId === user.id;
  // A replacement shop cannot read the previous shop's messages or files.
  return user.role === 'supplier' && reference.supplierId === user.id && clientShopChatParty(user, order, store) === 'supplier';
}

export function chatContactThreshold(settings) {
  return settings?.clientShopChatContactThreshold ?? 3;
}
