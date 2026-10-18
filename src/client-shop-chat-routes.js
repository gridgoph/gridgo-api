import { parseDeliveryMessage, parseDeliveryPhotoIds } from './delivery-chat.js';
import { maskChatContacts } from './chat-contact-masking.js';
import { tooManyRequests } from './support-rate-limit.js';
import { notifyAdmins } from './domain-events.js';
import { queueInvalidate } from './notifications.js';
import { CLIENT_SHOP_CHAT_PURPOSE, CLIENT_SHOP_CHAT_MAX_BYTES, CLIENT_SHOP_CHAT_TYPES,
  clientShopChatParty, clientShopChatProjection, chatContactThreshold, CHAT_WARNING, isChatStaff } from './client-shop-chat.js';

const ROUTE = /^\/orders\/([^/]+)\/client-shop-chat(?:\/(messages)(?:\/([0-9a-f-]{36})\/(reports))?)?$/;
const LABELS = { client: 'Client', supplier: 'Print shop', gridgo: 'GRIDGO' };
const REPORT_REASONS = new Set(['contact_sharing', 'inappropriate', 'change_request', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = value => value instanceof Date ? value.toISOString() : value;
export const isClientShopChatRoute = pathname => ROUTE.test(pathname);
const invalid = error => Object.assign(new Error(error), { status: 400, code: error });
function limitOf(search) {
  const value = search.get('limit') ?? '50';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw invalid('invalid_chat_limit');
  return Number(value);
}
function mapMessage(row, user, store) {
  const files = new Map((store.files || []).map(file => [file.fileId, file]));
  return {
    id: row.id, senderLabel: LABELS[row.sender_role], body: row.masked_body,
    mine: row.sender_user_id === user.id, createdAt: iso(row.created_at),
    attachments: (row.attachment_file_ids || []).map(id => files.get(id)).filter(file => file?.state === 'ready').map(file => ({
      fileId: file.fileId, contentType: file.detectedContentType, size: file.size,
      originalFilename: file.detectedContentType === 'application/pdf' ? 'document.pdf' : 'image.png',
    })),
    ...(isChatStaff(user) ? { originalBody: row.original_body, contactAttempt: row.contact_attempt } : {}),
  };
}
async function threadProjection(database, store, order, user, at) {
  const result = await database.query(`SELECT t.flagged_at,
      (SELECT count(*)::int FROM client_shop_chat_messages m WHERE m.order_id=t.order_id AND m.sender_user_id=$2 AND m.contact_attempt) AS own_attempts,
      (SELECT count(*)::int FROM client_shop_chat_messages m WHERE m.order_id=t.order_id AND m.contact_attempt) AS total_attempts,
      (SELECT count(*)::int FROM client_shop_chat_reports r WHERE r.order_id=t.order_id) AS report_count,
      (SELECT count(*)::int FROM client_shop_chat_messages m LEFT JOIN client_shop_chat_reads r ON r.order_id=m.order_id AND r.user_id=$2
        WHERE m.order_id=t.order_id AND m.sender_user_id<>$2 AND ($3::text IS NULL OR m.supplier_id=$3)
        AND (r.last_read_at IS NULL OR m.created_at>r.last_read_at)) AS unread
    FROM client_shop_chat_threads t WHERE t.order_id=$1`, [order.id, user.id, user.role === 'supplier' ? user.id : null]);
  const row = result.rows[0];
  const attempts = row?.own_attempts ?? 0;
  const threshold = chatContactThreshold(store.settings);
  return { ...clientShopChatProjection(order, user, store, at), unread: row?.unread ?? 0,
    contactAttempts: isChatStaff(user) ? row?.total_attempts ?? 0 : attempts,
    ...(attempts >= threshold && row?.flagged_at ? { warning: CHAT_WARNING } : {}),
    ...(isChatStaff(user) ? { flaggedAt: iso(row?.flagged_at) ?? null, reportCount: row?.report_count ?? 0, contactThreshold: threshold } : {}),
  };
}
function invalidate(store, order) {
  queueInvalidate(store, { resource: 'orders', id: order.id, userIds: [order.clientId] });
  if (order.supplierId) queueInvalidate(store, { resource: 'jobs', id: order.id, userIds: [order.supplierId] });
  queueInvalidate(store, { resource: 'chat', id: order.id });
}
function notifyParties(store, order, senderRole, { createId, at }) {
  const recipients = senderRole === 'client' ? [[order.supplierId, 'supplier', 'Client']]
    : senderRole === 'supplier' ? [[order.clientId, 'client', 'Print shop']]
      : [[order.clientId, 'client', 'GRIDGO'], [order.supplierId, 'supplier', 'GRIDGO']];
  for (const [userId, appRole, label] of recipients) {
    if (!userId) continue;
    const quiet = store.notifications.some(row => row.type === 'client_shop_chat_message' && row.orderId === order.id
      && row.userId === userId && row.appRole === appRole && !row.read && !row.deletedAt && Date.parse(at) - Date.parse(row.at) < 300000);
    if (!quiet) store.notifications.push({ id: createId('ntf'), userId, appRole, orderId: order.id,
      type: 'client_shop_chat_message', title: `Message from ${label}`, body: 'Open the order conversation in GRIDGO to read and reply.', read: false, at });
  }
}
function checkFiles(store, user, ids) {
  for (const id of ids) {
    const file = store.files.find(row => row.fileId === id);
    if (!file || file.ownerId !== user.id || file.purpose !== CLIENT_SHOP_CHAT_PURPOSE || file.state !== 'ready'
        || !CLIENT_SHOP_CHAT_TYPES.includes(file.detectedContentType) || !Number.isSafeInteger(file.size) || file.size <= 0
        || file.size > CLIENT_SHOP_CHAT_MAX_BYTES || (file.detectedContentType !== 'application/pdf' && !file.metadataSanitizedAt)) {
      throw invalid('invalid_chat_attachment');
    }
    if (file.references?.length) throw Object.assign(invalid('file_already_attached'), { status: 409 });
  }
}
async function listMessages(database, store, order, user, search) {
  const limit = limitOf(search);
  const after = search.get('after');
  if (after && !UUID.test(after)) throw invalid('invalid_chat_cursor');
  const supplier = user.role === 'supplier' ? user.id : null;
  if (after) {
    const cursor = await database.query('SELECT 1 FROM client_shop_chat_messages WHERE id=$1 AND order_id=$2 AND ($3::text IS NULL OR supplier_id=$3)', [after, order.id, supplier]);
    if (!cursor.rowCount) throw invalid('invalid_chat_cursor');
  }
  const result = await database.query(`SELECT * FROM client_shop_chat_messages m WHERE order_id=$1 AND ($2::text IS NULL OR supplier_id=$2)
    AND ($3::uuid IS NULL OR (m.created_at,m.id)>(SELECT created_at,id FROM client_shop_chat_messages WHERE id=$3))
    ORDER BY created_at,id LIMIT $4`, [order.id, supplier, after || null, limit + 1]);
  const page = result.rows.slice(0, limit);
  // Only mark the returned page read; later pages retain their unread status.
  if (page.length) await database.query(`INSERT INTO client_shop_chat_reads (order_id,user_id,last_read_at) VALUES ($1,$2,$3)
    ON CONFLICT (order_id,user_id) DO UPDATE SET last_read_at=GREATEST(client_shop_chat_reads.last_read_at,EXCLUDED.last_read_at)`, [order.id, user.id, page.at(-1).created_at]);
  return { messages: page.map(row => mapMessage(row, user, store)), nextAfter: result.rows.length > limit ? page.at(-1).id : null };
}
async function staffList(database, store, user, search, at) {
  const limit = limitOf(search);
  const offset = search.get('offset') ?? '0';
  if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw invalid('invalid_chat_offset');
  const result = await database.query(`SELECT order_id,created_at,updated_at FROM client_shop_chat_threads
    WHERE ($1::boolean=false OR flagged_at IS NOT NULL) ORDER BY updated_at DESC,order_id LIMIT $2 OFFSET $3`, [search.get('flagged') === '1', limit + 1, Number(offset)]);
  const threads = [];
  for (const row of result.rows.slice(0, limit)) {
    const order = store.orders.find(order => order.id === row.order_id);
    if (!order) continue;
    threads.push({ orderId: row.order_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      ...await threadProjection(database, store, order, user, at) });
  }
  return { threads, nextOffset: result.rows.length > limit ? Number(offset) + limit : null };
}

/** Same domain transaction, save/outbox and private file boundary as order rider chats. */
export async function routeClientShopChat({ req, res, pathname, user, store, database, readBody, send, save, createId, now }) {
  const match = ROUTE.exec(pathname);
  const listing = pathname === '/ops/client-shop-chats';
  if (!match && !listing) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!user) { send(res, 401, { error: 'unauthorized' }); return true; }
  const search = new URL(req.url, 'http://localhost').searchParams;
  const at = now();
  if (listing) {
    if (!isChatStaff(user) || !approvedStaff(store, user)) send(res, 403, { error: 'forbidden' });
    else if (req.method !== 'GET') send(res, 405, { error: 'method_not_allowed' });
    else send(res, 200, await staffList(database, store, user, search, at));
    return true;
  }
  const [, orderId, messagesPath, messageId, reportsPath] = match;
  if ((!messagesPath && req.method !== 'GET') || (messagesPath && req.method !== 'POST')) {
    send(res, 405, { error: 'method_not_allowed' }); return true;
  }
  const order = store.orders.find(row => row.id === orderId);
  if (!order) { send(res, 404, { error: 'order_not_found' }); return true; }
  const party = clientShopChatParty(user, order, store);
  if (!party) { send(res, 403, { error: 'forbidden' }); return true; }
  let chat = await threadProjection(database, store, order, user, at);
  if (!messagesPath) {
    const history = await listMessages(database, store, order, user, search);
    const result = { chat, ...history };
    if (isChatStaff(user)) {
      const reports = await database.query('SELECT id,message_id,reporter_role,reason,created_at FROM client_shop_chat_reports WHERE order_id=$1 ORDER BY created_at,id', [order.id]);
      result.reports = reports.rows.map(row => ({ id: row.id, messageId: row.message_id, reporterLabel: LABELS[row.reporter_role], reason: row.reason, createdAt: iso(row.created_at) }));
    }
    send(res, 200, result); return true;
  }
  if (tooManyRequests(`client-shop-chat:${user.id}`, 30, 10 * 60 * 1000)) {
    send(res, 429, { error: 'too_many_requests' }); return true;
  }
  const payload = await readBody(req);
  if (reportsPath) {
    const message = await database.query('SELECT id FROM client_shop_chat_messages WHERE id=$1 AND order_id=$2 AND ($3::text IS NULL OR supplier_id=$3)', [messageId, order.id, party === 'supplier' ? user.id : null]);
    if (!message.rowCount) { send(res, 404, { error: 'chat_message_not_found' }); return true; }
    if (!REPORT_REASONS.has(payload?.reason)) throw invalid('invalid_chat_report_reason');
    const inserted = await database.query(`INSERT INTO client_shop_chat_reports (order_id,message_id,reporter_user_id,reporter_role,reason,created_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id,reporter_user_id) DO NOTHING RETURNING id`, [order.id, messageId, user.id, party, payload.reason, at]);
    if (inserted.rowCount) {
      await database.query('UPDATE client_shop_chat_threads SET flagged_at=COALESCE(flagged_at,$2),updated_at=$2 WHERE order_id=$1', [order.id, at]);
      notifyAdmins(store, 'client_shop_chat_reported', 'Order conversation reported', order, `client-shop-report:${inserted.rows[0].id}`, { createId, at });
      auditActivity(store, user, order, 'client_shop_chat.reported', inserted.rows[0].id, createId, at);
      invalidate(store, order); await save(store);
    }
    send(res, 200, { ok: true }); return true;
  }
  if (chat.status !== 'open') { send(res, 409, { error: chat.status === 'unavailable' ? 'client_shop_chat_not_available' : 'client_shop_chat_read_only', chat }); return true; }
  const attachments = parseDeliveryPhotoIds(payload?.attachmentFileIds);
  const parsed = parseDeliveryMessage(payload?.body, { allowEmpty: attachments.ok && attachments.fileIds.length > 0 });
  if (!attachments.ok || !parsed.ok) throw invalid('invalid_request');
  checkFiles(store, user, attachments.fileIds);
  const masked = maskChatContacts(parsed.body);
  await database.query('INSERT INTO client_shop_chat_threads (order_id,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT (order_id) DO UPDATE SET updated_at=$2', [order.id, at]);
  const inserted = await database.query(`INSERT INTO client_shop_chat_messages (order_id,supplier_id,sender_user_id,sender_role,original_body,masked_body,contact_attempt,attachment_file_ids,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9) RETURNING *`, [order.id, order.supplierId, user.id, party, parsed.body, masked.text, masked.contactAttempt, attachments.fileIds, at]);
  const row = inserted.rows[0];
  for (const id of attachments.fileIds) store.files.find(file => file.fileId === id).references.push({ type: 'client_shop_chat_message', id: row.id,
    field: 'attachmentFileIds', orderId: order.id, supplierId: order.supplierId });
  if (masked.contactAttempt) {
    const count = await database.query('SELECT count(*)::int AS n FROM client_shop_chat_messages WHERE order_id=$1 AND sender_user_id=$2 AND contact_attempt', [order.id, user.id]);
    if (count.rows[0].n >= chatContactThreshold(store.settings)) {
      const flagged = await database.query('UPDATE client_shop_chat_threads SET flagged_at=$2 WHERE order_id=$1 AND flagged_at IS NULL RETURNING order_id', [order.id, at]);
      if (flagged.rowCount) notifyAdmins(store, 'client_shop_chat_flagged', 'Repeated contact sharing in order conversation', order, `client-shop-flag:${order.id}`, { createId, at });
    }
  }
  notifyParties(store, order, party, { createId, at });
  notifyAdmins(store, 'client_shop_chat_activity', 'Order conversation activity', order, `client-shop-message:${row.id}`, { createId, at });
  auditActivity(store, user, order, 'client_shop_chat.message_sent', row.id, createId, at);
  invalidate(store, order); await save(store);
  chat = await threadProjection(database, store, order, user, at);
  send(res, 201, { chat, message: mapMessage(row, user, store), ...(chat.warning ? { warning: chat.warning } : {}) });
  return true;
}
function approvedStaff(store, user) {
  return (store.userRoleMemberships || []).some(row => row.userId === user.id && row.role === user.role);
}
function auditActivity(store, user, order, action, entityId, createId, at) {
  store.auditLog.push({ id: createId('aud'), at, actorId: user.id, actorRole: user.role, action,
    entityType: 'client_shop_chat_message', entityId, orderId: order.id, detail: { senderLabel: LABELS[isChatStaff(user) ? 'gridgo' : user.role] } });
}
