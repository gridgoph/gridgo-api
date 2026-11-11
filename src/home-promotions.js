import { createHash } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { manilaDate } from './season-windows.js';

const FIELDS = {
  name: 'name', logo: 'logo_file_id', image: 'image_file_id', cardImage: 'card_image_file_id', description: 'description', tag: 'tag',
  linkText: 'link_text', linkUrl: 'link_url', tapAction: 'tap_action', style: 'style', color: 'color',
  startsAt: 'starts_at', endsAt: 'ends_at', enabled: 'enabled', displayOrder: 'display_order',
};
const colorForStyle = style => style === 'yellow' ? '#FFDE58' : '#FFFFFF';
const styleForColor = color => color === '#FFDE58' ? 'yellow' : 'light';
const staff = user => ['super_admin', 'ops_admin'].some(role => identityHasMembership(user, role));
const fail = (status, code, field) => { throw Object.assign(new Error(code), { status, code, details: field ? { field } : {} }); };
const invalid = field => fail(400, 'invalid_promotion', field);

export function promotionStatus(row, at) {
  if (row.removed_at || !row.enabled) return 'off';
  if (row.ends_at && Date.parse(at) >= Date.parse(row.ends_at)) return 'ended';
  return Date.parse(at) < Date.parse(row.starts_at) ? 'scheduled' : 'live';
}

function timestamp(value, field) {
  // Require an explicit offset: date-only/local inputs otherwise change with the server timezone.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) invalid(field);
  const day = value.slice(0, 10);
  if (day < '0001-01-01') invalid(field);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) invalid(field);
  return new Date(value).toISOString();
}

export function validatePromotion(body, previous = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('body');
  if (Object.keys(body).some(key => !Object.hasOwn(FIELDS, key))) invalid('body');
  const input = { tapAction: 'sheet', enabled: false, displayOrder: 0, image: null, cardImage: null, endsAt: null, ...previous, ...body };
  const value = {};
  for (const [field, max, required] of [['name', 120, true], ['description', 140, false], ['linkText', 80, true]]) {
    if (typeof input[field] !== 'string' || input[field].trim().length > max || (required && !input[field].trim())) invalid(field);
    value[field] = input[field].trim();
  }
  for (const [field, options] of [['tag', ['partner', 'sponsored', 'featured_shop']], ['tapAction', ['sheet', 'link']]]) {
    if (!options.includes(input[field])) invalid(field);
    value[field] = input[field];
  }
  if (Object.hasOwn(body, 'style') && !['light', 'yellow'].includes(body.style)) invalid('style');
  const color = Object.hasOwn(body, 'color') ? body.color
    : Object.hasOwn(body, 'style') ? colorForStyle(body.style) : input.color;
  if (typeof color !== 'string' || color.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(color)) invalid('color');
  value.color = color.toUpperCase();
  value.style = styleForColor(value.color);
  let link;
  try { link = new URL(input.linkUrl); } catch { invalid('linkUrl'); }
  if (typeof input.linkUrl !== 'string' || input.linkUrl.length > 2048 || link.protocol !== 'https:' || !link.hostname || link.username || link.password) invalid('linkUrl');
  value.linkUrl = link.href;
  if (typeof input.enabled !== 'boolean') invalid('enabled');
  if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0 || input.displayOrder > 2147483647) invalid('displayOrder');
  value.enabled = input.enabled;
  value.displayOrder = input.displayOrder;
  value.startsAt = timestamp(input.startsAt, 'startsAt');
  value.endsAt = input.endsAt === null ? null : timestamp(input.endsAt, 'endsAt');
  if (value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) invalid('endsAt');
  for (const field of ['logo', 'image', 'cardImage']) {
    const ref = input[field];
    if (field !== 'logo' && ref === null) { value[field] = null; continue; }
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.fileId !== 'string'
      || !ref.fileId || ref.fileId.length > 200 || Object.keys(ref).some(key => key !== 'fileId')) invalid(field);
    value[field] = { fileId: ref.fileId };
  }
  return value;
}

function valuesFromRow(row) {
  const value = Object.fromEntries(Object.entries(FIELDS).map(([js, sql]) => [js,
    ['logo', 'image', 'cardImage'].includes(js) ? (row[sql] ? { fileId: row[sql] } : null) : row[sql]]));
  return { ...value, style: styleForColor(value.color) };
}

async function project(row, { storage, store, at, totals = false }) {
  const result = { id: row.id, ...valuesFromRow(row), status: promotionStatus(row, at) };
  for (const field of ['logo', 'image', 'cardImage']) {
    const ref = result[field];
    if (!ref) continue;
    const file = store.files.find(item => item.fileId === ref.fileId && item.state === 'ready');
    if (!file) { result[field] = null; continue; }
    const signed = await storage.presignGet(file.objectKey);
    result[field] = { fileId: ref.fileId, contentType: file.detectedContentType, downloadUrl: signed.url, expiresAt: signed.expiresAt };
  }
  if (totals) for (const key of ['views', 'opens', 'taps']) result[key] = row[key] || 0;
  return result;
}

function media(store, value, user) {
  for (const field of ['logo', 'image', 'cardImage']) {
    if (!value[field]) continue;
    const file = store.files.find(item => item.fileId === value[field].fileId);
    if (!file || file.state !== 'ready' || file.purpose !== (field === 'cardImage' ? 'promotion_card_image' : `promotion_${field}`) || !file.objectKey
      || !['image/png', 'image/jpeg', 'image/webp'].includes(file.detectedContentType)) fail(409, 'promotion_file_not_ready', field);
    // Staff may reuse existing promotion media; an unbound upload belongs to its uploader.
    if (file.ownerId !== user.id && !(file.references || []).some(ref => ref.type === 'home_promotion')) fail(403, 'forbidden');
  }
}

export function bindPromotionMedia(store, promotionId, value, at) {
  for (const file of store.files) {
    file.references = (file.references || []).filter(ref => ref.type !== 'home_promotion' || ref.id !== promotionId);
    for (const field of ['logo', 'image', 'cardImage']) if (value?.[field]?.fileId === file.fileId) {
      file.references.push({ type: 'home_promotion', id: promotionId, field, attachedAt: at });
    }
  }
}

const TOTALS = `SELECT p.*, COALESCE(s.views,0)::bigint AS views, COALESCE(s.opens,0)::bigint AS opens, COALESCE(s.taps,0)::bigint AS taps
  FROM home_promotions p LEFT JOIN (
    SELECT promotion_id, sum(views) AS views, sum(opens) AS opens, sum(taps) AS taps
    FROM home_promotion_daily_stats GROUP BY promotion_id
  ) s ON s.promotion_id=p.id`;

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01'
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export async function recordPromotionEvent(database, promotionId, body, at) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['type', 'sessionId'].includes(key))
    || !['view', 'open', 'tap'].includes(body.type) || typeof body.sessionId !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.sessionId)) fail(400, 'invalid_promotion_event');
  const day = manilaDate(at);
  if (body.type === 'view') {
    const hash = createHash('sha256').update(body.sessionId).digest('hex');
    const inserted = await database.query(`INSERT INTO home_promotion_view_sessions(promotion_id,day,session_hash)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING promotion_id`, [promotionId, day, hash]);
    if (!inserted.rowCount) return;
  }
  // The interpolated identifier is selected exclusively from the validated enum above.
  const column = { view: 'views', open: 'opens', tap: 'taps' }[body.type];
  await database.query(`INSERT INTO home_promotion_daily_stats(promotion_id,day,${column}) VALUES ($1,$2,1)
    ON CONFLICT (promotion_id,day) DO UPDATE SET ${column}=home_promotion_daily_stats.${column}+1`, [promotionId, day]);
}

export async function routeHomePromotions({ req, url, user, store, database, storage, readBody, now, id, audit }) {
  const path = url.pathname;
  const staffRoute = /^\/ops\/promotions(?:\/[^/]+(?:\/stats)?)?$/.test(path);
  const home = path === '/me/promotions/home';
  const event = /^\/me\/promotions\/([^/]+)\/events$/.exec(path);
  if (!staffRoute && !home && !event) return null;
  if (!user) fail(401, 'unauthorized');
  if (staffRoute ? !staff(user) : !identityHasMembership(user, 'client')) fail(403, 'forbidden');
  const at = now();
  const projection = row => project(row, { storage, store, at, totals: staffRoute });
  if (home && req.method === 'GET') {
    const { rows } = await database.query(`SELECT * FROM home_promotions WHERE enabled AND removed_at IS NULL
      AND starts_at <= $1 AND (ends_at IS NULL OR ends_at > $1) ORDER BY display_order, starts_at, id`, [at]);
    const promotions = await Promise.all(rows.map(projection));
    return { status: 200, body: { promotions: promotions.filter(promo => promo.logo) } };
  }
  if (event && req.method === 'POST') {
    const { rows: [row] } = await database.query('SELECT * FROM home_promotions WHERE id=$1 AND removed_at IS NULL', [event[1]]);
    if (!row || promotionStatus(row, at) !== 'live') fail(404, 'promotion_not_found');
    await recordPromotionEvent(database, row.id, await readBody(req), at);
    return { status: 204 };
  }
  if (!staffRoute) fail(405, 'method_not_allowed');
  const promotionId = path.split('/')[3];
  if (!promotionId && req.method === 'GET') {
    const { rows } = await database.query(`${TOTALS} WHERE p.removed_at IS NULL ORDER BY p.display_order,p.starts_at,p.id`);
    return { status: 200, body: { promotions: await Promise.all(rows.map(projection)) } };
  }
  let previous;
  if (promotionId) {
    previous = (await database.query(`${TOTALS} WHERE p.id=$1 AND p.removed_at IS NULL`, [promotionId])).rows[0];
    if (!previous) fail(404, 'promotion_not_found');
  }
  if (path.endsWith('/stats') && req.method === 'GET') {
    const to = url.searchParams.get('to') || manilaDate(at);
    if (!date(to)) fail(400, 'invalid_promotion_stats_range');
    const from = url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    if (!date(from) || !date(to) || to < from || Date.parse(to) - Date.parse(from) > 365 * 86400000) fail(400, 'invalid_promotion_stats_range');
    const { rows } = await database.query(`SELECT to_char(d.day,'YYYY-MM-DD') AS day,
      COALESCE(s.views,0)::bigint AS views, COALESCE(s.opens,0)::bigint AS opens, COALESCE(s.taps,0)::bigint AS taps
      FROM generate_series($2::date,$3::date,interval '1 day') d(day)
      LEFT JOIN home_promotion_daily_stats s ON s.promotion_id=$1 AND s.day=d.day::date ORDER BY d.day`, [promotionId, from, to]);
    return { status: 200, body: { timeZone: 'Asia/Manila', from, to, days: rows } };
  }
  if (promotionId && !path.endsWith('/stats') && req.method === 'GET') return { status: 200, body: { promotion: await projection(previous) } };
  const creating = !promotionId && req.method === 'POST';
  const removing = promotionId && !path.endsWith('/stats') && req.method === 'DELETE';
  if (!creating && !removing && !(promotionId && !path.endsWith('/stats') && req.method === 'PATCH')) fail(405, 'method_not_allowed');
  const value = removing ? null : validatePromotion(await readBody(req), previous ? valuesFromRow(previous) : null);
  if (value) media(store, value, user);
  const currentId = promotionId || id('promo');
  let row;
  if (removing) {
    await database.query('UPDATE home_promotions SET removed_at=$2,updated_at=$2 WHERE id=$1', [currentId, at]);
  } else {
    const fields = Object.keys(FIELDS);
    const values = fields.map(key => ['logo', 'image', 'cardImage'].includes(key) ? value[key]?.fileId || null : value[key]);
    if (creating) {
      row = (await database.query(`INSERT INTO home_promotions(id,${Object.values(FIELDS).join(',')},created_at,updated_at)
        VALUES ($1,${fields.map((_, n) => `$${n + 2}`).join(',')},$${fields.length + 2},$${fields.length + 2}) RETURNING *`, [currentId, ...values, at])).rows[0];
    } else {
      row = (await database.query(`UPDATE home_promotions SET ${Object.values(FIELDS).map((sql, n) => `${sql}=$${n + 2}`).join(',')},updated_at=$${fields.length + 2}
        WHERE id=$1 RETURNING *`, [currentId, ...values, at])).rows[0];
      Object.assign(row, { views: previous.views, opens: previous.opens, taps: previous.taps });
    }
  }
  bindPromotionMedia(store, currentId, value, at);
  const action = creating ? 'created' : removing ? 'removed' : 'updated';
  audit(store, { actor: user, action: `home_promotion.${action}`, entityType: 'home_promotion', entityId: currentId,
    detail: { previous: previous ? valuesFromRow(previous) : null, current: value } });
  for (const membership of privilegedAdminMemberships(store)) {
    store.notifications.push({ id: id('ntf'), userId: membership.userId, appRole: membership.role, type: 'home_promotion_updated',
      title: 'Home promotion updated', body: `${value?.name || previous.name} was ${action}.`, at, read: false, push: false });
  }
  queueInvalidate(store, { resource: 'notifications', userIds: privilegedAdminMemberships(store).map(m => m.userId) });
  return removing ? { status: 204, mutated: true } : { status: creating ? 201 : 200, body: { promotion: await projection(row) }, mutated: true };
}
