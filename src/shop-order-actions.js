import { randomUUID } from 'node:crypto';
import { currentAuditActor, currentAuditRequest, finalizeAuditEntries } from './audit.js';

/** Persist the person, even when legacy route ownership uses a shop ID. */
export function recordOrderActions(store, baseline) {
  if (!baseline) return;
  const active = currentAuditActor();
  const request = currentAuditRequest();
  const requestPath = request ? new URL(request.url, 'http://localhost').pathname.split('/') : [];
  const orderRequest = order => active && ['POST','PATCH','PUT','DELETE'].includes(request?.method)
    && ((['orders','dispatch'].includes(requestPath[1]) && requestPath[2] === order.id)
      || (requestPath[1] === 'files' && store.files?.find(file => file.fileId === requestPath[2])?.references?.some(ref => ref.type === 'order' && ref.id === order.id)));
  store.orderActions ||= [];
  const previousOrders = new Map((baseline.orders || []).map(row => [row.id, row]));
  const oldAuditIds = new Set((baseline.auditLog || []).map(row => row.id));
  for (const order of store.orders || []) {
    const before = previousOrders.get(order.id);
    for (const entry of (order.timeline || []).slice(before?.timeline?.length || 0)) {
      const usesActive = active && (!entry.by || entry.by === active.id || entry.by === active.actorUserId);
      const personId = usesActive ? active.actorUserId || active.id || null : entry.by === 'system' ? null : entry.by || null;
      const person = store.users.find(row => row.id === personId);
      if (usesActive) entry.by = personId;
      entry.actor = { userId: personId, name: (usesActive && (active.actorName || active.name)) || person?.name || 'System',
        role: (usesActive && (active.shopRole || (active.role === 'supplier' ? 'owner' : active.role))) || person?.role || 'system' };
    }
    if (JSON.stringify(before) === JSON.stringify(order)) continue;
    if (orderRequest(order) && !(store.auditLog || []).some(row => !oldAuditIds.has(row.id) && (row.orderId === order.id || (row.entityType === 'order' && row.entityId === order.id)))) {
      store.orderActions.push({ id: `act_${randomUUID()}`, orderId: order.id, actorUserId: active.actorUserId || active.id,
        actorName: active.actorName || active.name || 'System', actorRole: active.shopRole || (active.role === 'supplier' ? 'owner' : active.role),
        action: 'order.updated', at: new Date().toISOString() });
    }
  }
  finalizeAuditEntries(store, baseline);
  store.orderActions ||= [];
  for (const entry of store.auditLog || []) {
    if (oldAuditIds.has(entry.id)) continue;
    const orderIds = [...new Set([entry.orderId, ...(entry.orderIds || [])].filter(Boolean))];
    for (const orderId of orderIds) {
      if (!store.orders.some(order => order.id === orderId)) continue;
      const id = `${entry.id}:${orderId}`;
      if (store.orderActions.some(row => row.id === id)) continue;
      store.orderActions.push({ id, orderId, actorUserId: entry.actorId || null,
        actorName: entry.actorName || 'System', actorRole: entry.actorShopRole || (entry.actorRole === 'supplier' ? 'owner' : entry.actorRole),
        action: entry.action, at: entry.at });
    }
  }
}
