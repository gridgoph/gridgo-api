import { identityHasMembership } from './authorization-context.js';
import { initVouchers, voucherFail as fail, normalizeVoucherCode, generatedVoucherCode, issueVoucher, addVoucherCode,
  publicVoucher, voucherEvent, releaseVoucherReservations } from './vouchers.js';

function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request'); return value; }
function reason(body) { if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) fail(400, 'voucher_reason_required'); return body.reason.trim(); }
const member = (user, role) => identityHasMembership(user, role);
function campaignInput(body, at) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const code = body.code == null ? generatedVoucherCode() : normalizeVoucherCode(body.code);
  if (!name || name.length > 120 || !/^[A-Z0-9-]{4,40}$/.test(code)
    || !['shared', 'assigned'].includes(body.mode) || !Number.isSafeInteger(body.valueMinor) || body.valueMinor <= 0
    || !Number.isSafeInteger(body.totalLimit) || body.totalLimit < 1 || body.totalLimit > 1000000
    || (body.perAccountLimit ?? 1) !== 1) fail(400, 'invalid_voucher_campaign');
  const endsAt = body.endsAt == null ? null : new Date(body.endsAt);
  const validityDays = body.validityDays ?? (endsAt ? null : 7);
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= Date.parse(at))
    || endsAt && validityDays != null || !endsAt && (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 365)) fail(400, 'invalid_voucher_validity');
  return { name, code, mode: body.mode, valueMinor: body.valueMinor, totalLimit: body.totalLimit, perAccountLimit: 1,
    endsAt: endsAt?.toISOString() ?? null, validityDays };
}
// CSV has one email and optional adultConfirmed column, with RFC 4180 escaping.
export function parseVoucherCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail(413, 'voucher_csv_too_large');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? '\n';
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') { quoted = false; closed = true; } else cell += ch; continue; }
    if (ch === '"' && !cell && !closed) { quoted = true; continue; }
    if (closed && ![',', '\r', '\n'].includes(ch)) fail(400, 'invalid_voucher_csv');
    if (ch === ',' || ch === '\n') { row.push(cell.trim()); cell = ''; closed = false; if (ch === '\n') { if (row.some(Boolean)) rows.push(row); row = []; } }
    else if (ch !== '\r') cell += ch;
  }
  if (quoted) fail(400, 'invalid_voucher_csv');
  const header = rows.shift()?.map(c => c.toLowerCase());
  if (!header || header[0] !== 'email' || header.length > 2 || header.length === 2 && header[1] !== 'adultconfirmed') fail(400, 'invalid_voucher_csv_header');
  return rows.map(row => { if (row.length > header.length || row[1] && !['true', 'false'].includes(row[1].toLowerCase())) fail(400, 'invalid_voucher_csv');
    return { email: row[0], adultConfirmed: row[1]?.toLowerCase() === 'true' }; });
}
const csvCell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
function audit(store, user, action, entityId, detail, id, at) {
  store.auditLog ||= [];
  store.auditLog.push({ id: id('aud'), at, actorId: user.id, actorRole: user.role, action: `voucher.${action}`, entityType: 'voucher', entityId, detail });
}
export async function routeVouchers({ req, url, store, user, readBody, readRawBody, id, now }) {
  const path = url.pathname;
  if (!/^\/(?:admin\/voucher|ops\/vouchers|me\/vouchers)/.test(path)) return null;
  if (!user) fail(401, 'unauthorized');
  const admin = member(user, 'super_admin'), ops = admin || member(user, 'ops_admin');
  if (path.startsWith('/admin/') && !admin || path.startsWith('/ops/') && !ops || path.startsWith('/me/') && !member(user, 'client')) fail(403, 'forbidden');
  initVouchers(store);
  const at = now();
  const result = (body, mutated = false, status = 200) => ({ status, body, mutated });
  if (path === '/me/vouchers' && req.method === 'GET' || path === '/ops/vouchers' && req.method === 'GET') {
    const clientId = path.startsWith('/ops/') ? url.searchParams.get('clientId') : user.id;
    if (!clientId) fail(400, 'voucher_client_required');
    const tab = url.searchParams.get('tab') || 'available';
    if (!['available', 'used', 'expired', 'all'].includes(tab)) fail(400, 'invalid_voucher_tab');
    return result({ serverTime: at, vouchers: store.vouchers.filter(v => v.clientId === clientId).map(v => publicVoucher(store, v, at))
      .filter(v => tab === 'all' || v.status === tab || tab === 'expired' && v.status === 'void') });
  }
  if (path === '/me/vouchers/code' && req.method === 'POST') return addVoucherCode(store, user.id, object(await readBody(req)).code, { id, at });
  if (path === '/admin/voucher-redemptions' && req.method === 'GET') {
    for (const key of ['from', 'to']) if (url.searchParams.has(key) && !Number.isFinite(Date.parse(url.searchParams.get(key)))) fail(400, 'invalid_voucher_date');
    const filtered = store.voucherLedger.filter(row => ['campaignId', 'clientId', 'kind'].every(key => !url.searchParams.has(key) || row[key] === url.searchParams.get(key))
      && (!url.searchParams.has('from') || Date.parse(row.at) >= Date.parse(url.searchParams.get('from')))
      && (!url.searchParams.has('to') || Date.parse(row.at) <= Date.parse(url.searchParams.get('to'))));
    const budgetUsedMinor = filtered.reduce((total, row) => total + BigInt(['redeemed', 'restored'].includes(row.kind) ? row.amountMinor : 0), 0n).toString();
    if (url.searchParams.get('format') === 'csv') {
      const fields = ['id', 'campaignId', 'voucherId', 'clientId', 'kind', 'amountMinor', 'at'];
      return { status: 200, bytes: Buffer.from([fields.join(','), ...filtered.map(row => fields.map(f => csvCell(row[f])).join(','))].join('\r\n')), contentType: 'text/csv; charset=utf-8', filename: 'voucher-ledger.csv' };
    }
    const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_pagination');
    return result({ entries: filtered.slice().reverse().slice(offset, offset + limit), total: filtered.length, budgetUsedMinor,
      budgetUsedScope: 'filtered_net_redemptions', serverTime: at });
  }
  const campaigns = /^\/admin\/voucher-campaigns(?:\/([^/]+)(?:\/(status|issue))?)?$/.exec(path);
  if (campaigns) {
    const campaign = store.voucherCampaigns.find(c => c.id === campaigns[1]);
    if (req.method === 'GET' && !campaigns[2]) {
      if (campaigns[1] && !campaign) fail(404, 'voucher_campaign_not_found');
      return result(campaign ? { campaign } : { campaigns: store.voucherCampaigns });
    }
    if (req.method === 'POST' && !campaigns[1]) {
      const body = object(await readBody(req));
      const input = campaignInput(body, at);
      if (store.voucherCampaigns.some(c => c.code === input.code)) fail(409, 'voucher_code_exists');
      const created = { ...input, id: id('vcamp'), status: 'draft', createdAt: at, updatedAt: at };
      store.voucherCampaigns.push(created); audit(store, user, 'campaign_created', created.id, {}, id, at);
      return result({ campaign: created }, true, 201);
    }
    if (!campaign) fail(404, 'voucher_campaign_not_found');
    if (req.method === 'PATCH' && !campaigns[2]) {
      if (campaign.status !== 'draft' || store.vouchers.some(v => v.campaignId === campaign.id)) fail(409, 'voucher_campaign_immutable');
      const input = campaignInput({ ...campaign, ...object(await readBody(req)) }, at);
      if (store.voucherCampaigns.some(c => c.id !== campaign.id && c.code === input.code)) fail(409, 'voucher_code_exists');
      Object.assign(campaign, input, { updatedAt: at }); audit(store, user, 'campaign_updated', campaign.id, {}, id, at);
      return result({ campaign }, true);
    }
    if (req.method === 'DELETE' && !campaigns[2]) {
      if (campaign.status !== 'draft' || store.vouchers.some(v => v.campaignId === campaign.id)) fail(409, 'voucher_campaign_immutable');
      store.voucherCampaigns = store.voucherCampaigns.filter(c => c !== campaign);
      audit(store, user, 'campaign_deleted', campaign.id, {}, id, at); return result({ ok: true }, true);
    }
    if (req.method === 'POST' && campaigns[2] === 'status') {
      const body = object(await readBody(req));
      const allowed = { draft: ['active', 'ended'], active: ['paused', 'ended'], paused: ['active', 'ended'], ended: [] };
      if (!allowed[campaign.status].includes(body.status)) fail(409, 'voucher_campaign_status_conflict');
      if (body.status === 'active' && campaign.endsAt && Date.parse(campaign.endsAt) <= Date.parse(at)) fail(409, 'voucher_campaign_expired');
      campaign.status = body.status; campaign.updatedAt = at;
      audit(store, user, 'campaign_status', campaign.id, { status: body.status }, id, at); return result({ campaign }, true);
    }
    if (req.method === 'POST' && campaigns[2] === 'issue') {
      if (campaign.mode !== 'assigned') fail(409, 'voucher_assigned_campaign_required');
      const csv = String(req.headers?.['content-type'] || '').split(';')[0] === 'text/csv';
      const body = csv ? null : object(await readBody(req));
      const entries = csv ? parseVoucherCsv((await readRawBody(req)).toString('utf8')) : body.recipients ?? body.emails;
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1000) fail(400, 'invalid_voucher_recipients');
      const matched = [], unmatched = [];
      for (const entry of entries) {
        const email = (typeof entry === 'string' ? entry : entry?.email)?.trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { unmatched.push({ email: email || '', reason: 'invalid_email' }); continue; }
        const clients = store.users.filter(u => String(u.email).toLowerCase() === email && store.userRoleMemberships.some(m => m.userId === u.id && m.role === 'client'));
        if (clients.length !== 1) { unmatched.push({ email, reason: clients.length ? 'ambiguous_email' : 'no_client_account' }); continue; }
        const issued = issueVoucher(store, campaign, clients[0].id, { id, at, actorId: user.id, adultConfirmed: entry?.adultConfirmed === true });
        matched.push({ email, clientId: clients[0].id, voucherId: issued.voucher.id, issued: issued.issued });
      }
      audit(store, user, 'bulk_issue', campaign.id, { matched: matched.length, unmatched: unmatched.length }, id, at);
      return result({ matched, unmatched }, true);
    }
  }
  const item = /^\/admin\/vouchers\/([^/]+)\/(void|reissue)$/.exec(path);
  if (item && req.method === 'POST') {
    const voucher = store.vouchers.find(v => v.id === item[1]);
    if (!voucher) fail(404, 'voucher_not_found');
    const body = object(await readBody(req)), why = reason(body);
    if (item[2] === 'void') {
      if (voucher.status !== 'available') fail(409, 'voucher_not_voidable');
      if (store.voucherReservations.some(r => r.voucherId === voucher.id && r.status === 'reserved' && r.data.orderIds?.length)) fail(409, 'voucher_payment_reconciliation_required');
      releaseVoucherReservations(store, { id, at }, r => r.voucherId === voucher.id);
      voucher.status = 'void'; voucher.data.voidedAt = at;
    } else {
      if (voucher.status !== 'void') fail(409, 'voucher_not_reissuable');
      if (Date.parse(voucher.expiresAt) <= Date.parse(at)) fail(409, 'voucher_expired');
      voucher.status = 'available';
    }
    voucherEvent(store, voucher, item[2], { id, at, actorId: user.id, reason: why });
    audit(store, user, item[2], voucher.id, { reason: why }, id, at);
    return result({ voucher: publicVoucher(store, voucher, at) }, true);
  }
  fail(404, 'not_found');
}
