import { actorUserId } from './shop-team.js';
import { currentAuditActor } from './audit.js';
import { clientShopChatWindow, clientShopChatParty } from './client-shop-chat.js';
import { queueInvalidate } from './notifications.js';

export const firstName = name => {
  const word = String(name || '').trim().split(/\s+/)[0];
  return /^[\p{L}\p{M}'’-]{1,80}$/u.test(word) ? word : 'Team';
};
export const chatWorkerKey = user => user?.actorPinStaffId ? `pin:${user.actorPinStaffId}` : `user:${actorUserId(user)}`;
export function chatSender(store, user) {
  const pin = user.actorPinStaffId && store.shopPinStaff?.find(row => row.id === user.actorPinStaffId);
  const preferences = store.shopTeamMemberSettings?.find(row => row.shopId === user.id && row.userId === actorUserId(user));
  return { firstName: firstName(user.actorName || store.users.find(row => row.id === actorUserId(user))?.name),
    shop: store.supplierProfiles.find(row => row.userId === user.id)?.shopName || 'Print shop',
    workerKey: chatWorkerKey(user), photoFileId: pin?.photoFileId || preferences?.photoFileId || null };
}

export async function chatTyping(database, order, user, at) {
  if (clientShopChatWindow(order, at).status !== 'open') return [];
  const result = await database.query(`SELECT first_name,sender_role,expires_at FROM client_shop_chat_typing
    WHERE order_id=$1 AND supplier_id=$2 AND worker_key<>$3 AND expires_at>$4 ORDER BY worker_key`,
  [order.id, order.supplierId, chatWorkerKey(user), at]);
  return result.rows.map(row => ({ firstName: row.first_name, role: row.sender_role, expiresAt: row.expires_at }));
}

/** Runs inside save's domain transaction, after actor attribution and before commit. */
export async function syncShopChatEvents(database, store, baseline, at) {
  const previous = new Map((baseline?.orders || []).map(row => [row.id, row]));
  for (const order of store.orders || []) {
    const before = previous.get(order.id);
    if (!before || order.orderType !== 'express') continue;
    const accepted = order.shopAcceptance?.status === 'accepted' && before.shopAcceptance?.status !== 'accepted';
    const ready = ['ready_for_dispatch', 'awaiting_collection'].includes(order.state) && order.state !== before.state;
    if (!accepted && !ready) continue;
    const active = currentAuditActor();
    const user = active || store.users.find(row => row.id === (order.shopAcceptance?.acceptedBy || order.supplierId));
    const sender = chatSender(store, { ...user, id: order.supplierId,
      actorUserId: actorUserId(user), actorName: user?.actorName || user?.name,
      actorPinStaffId: user?.actorPinStaffId });
    await database.query(`INSERT INTO client_shop_chat_threads(order_id,created_at,updated_at,owner_worker_key,owner_first_name)
      VALUES($1,$2,$2,$3,$4) ON CONFLICT(order_id) DO UPDATE SET updated_at=$2,
      owner_worker_key=COALESCE(client_shop_chat_threads.owner_worker_key,EXCLUDED.owner_worker_key),
      owner_first_name=COALESCE(client_shop_chat_threads.owner_first_name,EXCLUDED.owner_first_name)`,
    [order.id, at, accepted ? sender.workerKey : null, accepted ? sender.firstName : null]);
    const event = accepted ? 'accepted' : 'ready';
    const text = `${sender.firstName} ${accepted ? 'accepted the order' : 'marked it ready'}`;
    await database.query(`INSERT INTO client_shop_chat_messages(order_id,supplier_id,sender_user_id,sender_role,original_body,masked_body,
      created_at,sender_first_name,sender_shop,sender_worker_key,sender_photo_file_id,system_event)
      VALUES($1,$2,$3,'supplier',$4,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [order.id, order.supplierId, actorUserId(user) || order.supplierId, text, at, sender.firstName, sender.shop, sender.workerKey, sender.photoFileId, event]);
    queueInvalidate(store, { resource: 'chat', id: order.id });
    queueInvalidate(store, { resource: 'orders', id: order.id, userIds: [order.clientId] });
    queueInvalidate(store, { resource: 'jobs', id: order.id, userIds: [order.supplierId,
      ...(store.shopMemberships || []).filter(m => m.shopId === order.supplierId && m.status === 'active').map(m => m.userId)] });
  }
}

export async function shopChatInbox(database, store, user, search, at, mapMessage) {
  if (user.role !== 'supplier') throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
  const filter = search.get('filter') || 'all';
  const limit = Number(search.get('limit') || 50), offset = Number(search.get('offset') || 0);
  if (!['all', 'needs_reply', 'mine'].includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
    throw Object.assign(new Error('invalid_chat_filter'), { status: 400, code: 'invalid_chat_filter' });
  const result = await database.query(`SELECT o.id,t.owner_worker_key,t.owner_first_name,
      COALESCE(last_message.created_at,t.updated_at,o.created_at) AS activity_at,
      to_jsonb(last_message.*) AS last_message,
      (SELECT count(*)::int FROM client_shop_chat_messages m LEFT JOIN client_shop_chat_reads r ON r.order_id=m.order_id AND r.user_id=$2
        WHERE m.order_id=o.id AND m.supplier_id=$1 AND m.sender_role='client' AND (r.last_read_position IS NULL OR m.position>r.last_read_position)) AS unread,
      (SELECT min(m.created_at) FROM client_shop_chat_messages m WHERE m.order_id=o.id AND m.supplier_id=$1 AND m.sender_role='client'
        AND NOT EXISTS(SELECT 1 FROM client_shop_chat_messages reply WHERE reply.order_id=o.id AND reply.supplier_id=$1
          AND reply.sender_role='supplier' AND reply.system_event IS NULL AND reply.position>m.position)) AS unanswered_since,
      (SELECT jsonb_agg(DISTINCT jsonb_build_object('firstName',m.sender_first_name,'workerKey',m.sender_worker_key))
        FROM client_shop_chat_messages m WHERE m.order_id=o.id AND m.supplier_id=$1 AND m.sender_role='supplier' AND m.system_event IS NULL) AS handlers
    FROM orders o LEFT JOIN client_shop_chat_threads t ON t.order_id=o.id
    LEFT JOIN LATERAL(SELECT * FROM client_shop_chat_messages m WHERE m.order_id=o.id AND m.supplier_id=$1 ORDER BY position DESC LIMIT 1) last_message ON true
    WHERE o.supplier_id=$1 AND o.data->>'orderType'='express'
      AND (o.data#>'{expressOrder,events}') @> '[{"state":"sending"}]'::jsonb
      AND NOT EXISTS(SELECT 1 FROM order_removals removed WHERE removed.order_id=o.id)
      AND ($3<>'mine' OR t.owner_worker_key=$4)
    ORDER BY activity_at DESC,o.id`, [user.id, actorUserId(user), filter, chatWorkerKey(user)]);
  const accessible = result.rows.filter(row => clientShopChatParty(user, store.orders.find(order => order.id === row.id), store) === 'supplier');
  const rows = accessible
    .filter(row => filter !== 'needs_reply' || row.unanswered_since);
  return { threads: rows.slice(offset, offset + limit).map(row => {
    const order = store.orders.find(o => o.id === row.id);
    return { orderId: order.id, orderNumber: order.orderNumber || order.id, status: order.state,
      clientFirstName: firstName(store.users.find(u => u.id === order.clientId)?.name),
      chat: clientShopChatWindow(order, at, store.settings), updatedAt: row.activity_at, unread: row.unread,
      needsReply: Boolean(row.unanswered_since), unansweredSince: row.unanswered_since,
      owner: row.owner_worker_key ? { firstName: row.owner_first_name, mine: row.owner_worker_key === chatWorkerKey(user) } : null,
      followedUpBy: (row.handlers || []).filter(h => h.workerKey !== row.owner_worker_key).map(h => ({ firstName: h.firstName })),
      lastMessage: row.last_message ? mapMessage(row.last_message, user, store) : null };
  }), unreadCount: accessible.reduce((n, row) => n + row.unread, 0), nextOffset: rows.length > offset + limit ? offset + limit : null };
}
