// Private write capability, never inferred from a caller-controlled store field.
const scopes = new WeakMap();
export const clientSaveScope = store => scopes.get(store);
export function bindClientSaveScope(store, scope) { scopes.set(store, scope); return store; }

/** Catalogue/workload rows are policy context, not incidental maintenance targets. */
export function saveMaintenanceView(store) {
  const scope = clientSaveScope(store);
  if (!scope) return store;
  const orders = store.orders.filter(order => order.clientId === scope.clientId);
  const ids = new Set(orders.map(order => order.id));
  return { ...store, orders,
    orderJobs: store.orderJobs.filter(row => ids.has(row.orderId)),
    orderLineItems: store.orderLineItems.filter(row => ids.has(row.orderId)),
    files: store.files.filter(file => file.ownerId === scope.clientId
      || (file.references || []).some(ref => ref.type === 'order' && ids.has(ref.id))),
  };
}

export function isClientSavePath(method, pathname) {
  return method === 'POST' && ['/me/matches', '/me/matches/next'].includes(pathname)
    || method === 'POST' && /^\/me\/carts\/[^/]+\/lines$/.test(pathname)
    || ['PATCH', 'DELETE'].includes(method) && /^\/me\/carts\/[^/]+\/lines\/[^/]+$/.test(pathname);
}
