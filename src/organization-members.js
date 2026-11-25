import { randomBytes } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { requestClientKey, tooManyRequests } from './support-rate-limit.js';
import { verifiedIdentities } from './shop-team.js';
import { sameReviewData } from './review-data.js';
import { activeOrderSql } from './order-removal.js';
import { sumMinor } from './refund-policy.js';
import { memberFail as fail, memberEvent, manilaDay, schoolYear, termFromCode, partnerFor, perkSettingFor, activePerk, usablePerk, perkUses, perkSpentMinor, perkLabel, perkOffer, membershipLive } from './member-perks.js';
import { checkMemberList, saveMemberList, listOpenEntries, removeEntry, closeOrganizationEntries, closeClientEntries, matchEntries, matchedEntries, parseMemberSince, sweepMemberList } from './member-list.js';
import { routeOrganizationEvents, eventSummaries } from './organization-events.js';

const PENDING_LIMIT = 2000;
const JOIN_ATTEMPTS_PER_HOUR = 20;
const JOIN_FAILURES = 5;
const JOIN_LOCK_MS = 15 * 60000;
const BENEFITS = ['badge', 'jointPromos', 'boothSupport'];

const CLIENT = /^\/me\/memberships(?:\/|$)/;
const OFFICER = /^\/me\/organization\/(members|partnership|events)(?:\/|$)/;
const STAFF = /^\/ops\/(?:member-perk|organization-partners)(?:\/|$)/;
export const isMemberRoute = path => CLIENT.test(path) || OFFICER.test(path) || STAFF.test(path);
/** The only two writes that need the caller's Clerk-verified addresses. */
export const needsVerifiedAddresses = path => path === '/me/memberships/matches' || /^\/me\/memberships\/matches\/[^/]+\/confirm$/.test(path);

const usersName = (store, userId) => store.users.find(row => row.id === userId)?.name || 'Member';
const rowsFor = (store, organizationUserId) => (store.organizationMemberships || []).filter(row => row.organizationUserId === organizationUserId);
const liveMemberships = (store, organizationUserId, at) => rowsFor(store, organizationUserId).filter(row => membershipLive(row, at));
const statusAt = (row, at) => row.status === 'active' && !membershipLive(row, at) ? 'expired' : row.status;
const termsCount = row => (row.data.terms || []).length;
const publicTerm = code => { const term = termFromCode(code); return { code: term.code, label: term.label, endsOn: term.endsOn }; };
const bump = (row, at) => { row.version += 1; row.updatedAt = at; };

/** The perk on one membership as its own member sees it. Budget figures stay with GRIDGO. */
function memberPerkView(store, row, at) {
  const perk = activePerk(store, row.organizationUserId, at);
  const used = perkUses(store, row).length, totalSavedMinor = sumMinor((store.memberPerkUses || [])
    .filter(use => use.membershipId === row.id && use.status === 'confirmed').map(use => use.amountMinor));
  if (!perk || !partnerFor(store, row.organizationUserId)) return { perk: null, totalSavedMinor };
  const usable = usablePerk(store, row, at);
  return { totalSavedMinor, perk: { amountMinor: perk.amountMinor, maxOrdersPerTerm: perk.maxOrdersPerTerm, used, left: Math.max(0, perk.maxOrdersPerTerm - used),
    validUntil: Date.parse(perk.endsAt) < Date.parse(row.termEndsAt) ? perk.endsAt : row.termEndsAt,
    available: Boolean(usable && usable.remainingBudgetMinor > 0), fundedBy: 'GRIDGO' } };
}
function ownMembership(store, row, at) {
  return { id: row.id, label: perkLabel(store, row.organizationUserId), organizationName: (store.organizationAccounts || [])
    .find(account => account.userId === row.organizationUserId)?.name || null, partner: Boolean(partnerFor(store, row.organizationUserId)),
  status: statusAt(row, at), memberSince: row.memberSince, term: publicTerm(row.term), termsCount: termsCount(row),
  requestedAt: row.requestedAt, ...(row.status === 'removed' ? { removedReason: row.data.removedReason || null } : {}), ...memberPerkView(store, row, at) };
}
function publicMatch(store, entry, at) {
  return { id: entry.id, label: perkLabel(store, entry.organization_user_id), organizationName: (store.organizationAccounts || [])
    .find(account => account.userId === entry.organization_user_id)?.name || null, memberSince: entry.member_since, term: publicTerm(entry.term),
  expiresAt: entry.expires_at, perk: perkOffer(store, entry.organization_user_id, at) };
}
async function clientBody(store, database, user, at) {
  const memberships = (store.organizationMemberships || []).filter(row => row.clientId === user.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(row => ownMembership(store, row, at));
  const matches = (await matchedEntries(database, user.id, at)).filter(entry => partnerFor(store, entry.organization_user_id) && joinable(store, user, entry.organization_user_id)
    && !rowsFor(store, entry.organization_user_id).some(row => row.clientId === user.id && membershipLive(row, at))).map(entry => publicMatch(store, entry, at));
  return { serverTime: at, memberships, matches };
}
function joinable(store, user, organizationUserId) {
  const client = store.users.find(row => row.id === user.id), organization = store.users.find(row => row.id === organizationUserId);
  return user.id !== organizationUserId && client && organization && sameReviewData(client, organization);
}

/** Every token look-up counts, so neither join nor preview can be used to guess links. */
// A whole campus can share one address, so the account limit does the real work.
async function joinAttempt(database, req, userId, at) {
  if (tooManyRequests(`member-join:${requestClientKey(req)}`, 600, 3600000)) return { status: 429, body: { error: 'member_join_rate_limited' } };
  const row = (await database.query('SELECT * FROM member_join_attempts WHERE client_id = $1 FOR UPDATE', [userId])).rows[0];
  if (row?.locked_until && Date.parse(row.locked_until) > Date.parse(at)) return { status: 429, body: { error: 'member_join_rate_limited', retryAt: row.locked_until } };
  const fresh = !row || Date.parse(at) - Date.parse(row.window_at) >= 3600000;
  const next = { windowAt: fresh ? at : row.window_at, attempts: fresh ? 1 : row.attempts + 1, failures: fresh ? 0 : row.failures };
  if (next.attempts > JOIN_ATTEMPTS_PER_HOUR) return { status: 429, body: { error: 'member_join_rate_limited', retryAt: new Date(Date.parse(next.windowAt) + 3600000).toISOString() } };
  await database.query(`INSERT INTO member_join_attempts (client_id, window_at, attempts, failures, locked_until) VALUES ($1,$2,$3,$4,NULL)
    ON CONFLICT (client_id) DO UPDATE SET window_at = excluded.window_at, attempts = excluded.attempts, failures = excluded.failures, locked_until = NULL`,
  [userId, next.windowAt, next.attempts, next.failures]);
  return null;
}
/** One answer for unknown, replaced, past-term and ended links. Returned, not thrown, so the count commits. */
async function joinFailure(database, userId, at) {
  const { rows } = await database.query(`UPDATE member_join_attempts SET failures = failures + 1,
    locked_until = CASE WHEN failures + 1 >= $2 THEN $3::timestamptz END WHERE client_id = $1 RETURNING failures`,
  [userId, JOIN_FAILURES, new Date(Date.parse(at) + JOIN_LOCK_MS).toISOString()]);
  return rows[0]?.failures >= JOIN_FAILURES ? { status: 429, body: { error: 'member_join_rate_limited' } } : { status: 404, body: { error: 'member_invite_not_found' } };
}
async function inviteFor(store, database, user, token, at) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const link = (await database.query('SELECT * FROM member_join_links WHERE token = $1 AND term = $2', [token, schoolYear(at).code])).rows[0];
  return link && partnerFor(store, link.organization_user_id) && joinable(store, user, link.organization_user_id) ? link : null;
}

/** The single way a person becomes a member: an officer's approval or their own list confirmation. */
function activate(store, row, { memberSince, term, by, at }) {
  const terms = (row.data.terms || []).filter(entry => entry.term !== term.code);
  Object.assign(row, { status: 'active', memberSince, term: term.code, termEndsAt: term.endsAt,
    data: { ...row.data, removedReason: null, terms: [...terms, { term: term.code, approvedAt: at, approvedBy: by }] } });
  bump(row, at);
}
function removeMembership(row, removedReason, at, by) {
  row.status = 'removed'; row.data = { ...row.data, removedReason, removedAt: at, removedBy: by };
  bump(row, at);
}

async function routeClient({ req, path, store, user, input, database, at, id, clerk }) {
  const result = (body, status = 200, mutated = true) => ({ status, body, mutated });
  const own = membershipId => {
    const row = (store.organizationMemberships || []).find(item => item.id === membershipId && item.clientId === user.id);
    return row || fail(404, 'membership_not_found');
  };
  if (path === '/me/memberships' && req.method === 'GET') return result(await clientBody(store, database, user, at), 200, false);
  if (path === '/me/memberships/preview' && req.method === 'POST') {
    const body = await input(), limited = await joinAttempt(database, req, user.id, at);
    if (limited) return limited;
    const link = await inviteFor(store, database, user, body.token, at);
    if (!link) return joinFailure(database, user.id, at);
    const existing = rowsFor(store, link.organization_user_id).find(row => row.clientId === user.id);
    return result({ invite: { label: perkLabel(store, link.organization_user_id), organizationName: (store.organizationAccounts || [])
      .find(account => account.userId === link.organization_user_id)?.name || null, term: publicTerm(link.term),
    perk: perkOffer(store, link.organization_user_id, at), membershipStatus: existing ? statusAt(existing, at) : null } }, 200, false);
  }
  if (path === '/me/memberships' && req.method === 'POST') {
    const body = await input();
    if (!['qr', 'link'].includes(body.source)) fail(400, 'invalid_member_source');
    const limited = await joinAttempt(database, req, user.id, at);
    if (limited) return limited;
    const link = await inviteFor(store, database, user, body.token, at);
    if (!link) return joinFailure(database, user.id, at);
    const organizationUserId = link.organization_user_id, term = schoolYear(at);
    let row = rowsFor(store, organizationUserId).find(item => item.clientId === user.id);
    if (row && (membershipLive(row, at) || row.status === 'pending' && row.term === term.code)) return result({ membership: ownMembership(store, row, at) }, 200, false);
    if (rowsFor(store, organizationUserId).filter(item => item.status === 'pending').length >= PENDING_LIMIT) fail(409, 'member_requests_full');
    const fields = { status: 'pending', source: body.source, term: term.code, termEndsAt: term.endsAt, requestedAt: at, updatedAt: at };
    if (row) { Object.assign(row, fields, { version: row.version + 1, data: { ...row.data, removedReason: null } }); } else {
      row = { id: id('mem'), organizationUserId, clientId: user.id, memberSince: null, version: 1, createdAt: at, data: { terms: [] }, ...fields };
      store.organizationMemberships.push(row);
    }
    memberEvent(store, 'membership.requested', { id, at, actor: user, entityId: row.id, organizationUserId, detail: { source: body.source, term: term.code },
      notify: [{ userId: organizationUserId, title: 'New member request', body: 'Someone asked to join your organization. Open Members to approve or decline.' }],
      staffBody: 'A member request was received.' });
    return result({ membership: ownMembership(store, row, at) }, 201);
  }
  if (path === '/me/memberships/matches' && req.method === 'POST' || /^\/me\/memberships\/matches\/[^/]+\/confirm$/.test(path) && req.method === 'POST') {
    if (clerk?.limited) return { status: 429, body: { error: 'member_match_rate_limited' } };
    if (!clerk?.clerkUser || clerk.clerkUser.id !== user.clerkUserId) fail(502, 'clerk_unavailable');
    const identities = verifiedIdentities(clerk.clerkUser);
    if (path === '/me/memberships/matches') {
      await matchEntries(database, user.id, identities, at);
      return result(await clientBody(store, database, user, at), 200, false);
    }
    const entry = (await matchedEntries(database, user.id, at)).find(row => row.id === path.split('/')[4]);
    // The address may have changed since it matched; confirm only what is verified now.
    if (!entry || !partnerFor(store, entry.organization_user_id) || !joinable(store, user, entry.organization_user_id)
      || ![...identities.email, ...identities.phone].includes(entry.contact)) fail(404, 'member_match_not_found');
    const term = termFromCode(entry.term);
    if (term.code !== schoolYear(at).code) fail(404, 'member_match_not_found');
    const organizationUserId = entry.organization_user_id;
    let row = rowsFor(store, organizationUserId).find(item => item.clientId === user.id);
    if (!row) {
      row = { id: id('mem'), organizationUserId, clientId: user.id, status: 'pending', source: 'list', term: term.code, termEndsAt: term.endsAt, memberSince: entry.member_since,
        requestedAt: at, version: 0, createdAt: at, updatedAt: at, data: { terms: [] } };
      store.organizationMemberships.push(row);
    }
    if (!membershipLive(row, at)) {
      row.source = 'list';
      activate(store, row, { memberSince: entry.member_since, term, by: 'member_list', at });
      memberEvent(store, 'membership.confirmed', { id, at, actor: user, entityId: row.id, organizationUserId, detail: { source: 'list', term: term.code },
        notify: [{ userId: organizationUserId, title: 'Member confirmed', body: 'A member on your list confirmed their membership.' },
          { userId: user.id, title: 'You are a member', body: `You are now a ${perkLabel(store, organizationUserId)}.` }], staffBody: 'A member confirmed from a member list.' });
    }
    await closeClientEntries(database, organizationUserId, user.id, 'accepted', at);
    return result({ membership: ownMembership(store, row, at) });
  }
  const dismissal = /^\/me\/memberships\/matches\/([^/]+)\/dismiss$/.exec(path);
  if (dismissal && req.method === 'POST') {
    const entry = (await matchedEntries(database, user.id, at)).find(row => row.id === dismissal[1]);
    if (!entry) fail(404, 'member_match_not_found');
    await closeClientEntries(database, entry.organization_user_id, user.id, 'dismissed', at);
    memberEvent(store, 'membership.not_me', { id, at, actor: null, entityType: 'member_list_entry', entityId: entry.id, organizationUserId: entry.organization_user_id,
      staffBody: 'Someone on a member list said it was not them.' });
    return result(await clientBody(store, database, user, at));
  }
  const item = /^\/me\/memberships\/([^/]+)$/.exec(path);
  if (item && req.method === 'DELETE') {
    const row = own(item[1]), was = statusAt(row, at);
    if (was === 'removed') return result({ membership: ownMembership(store, row, at) }, 200, false);
    removeMembership(row, was === 'pending' ? 'request_cancelled' : 'left', at, user.id);
    memberEvent(store, was === 'pending' ? 'membership.request_cancelled' : 'membership.left', { id, at, actor: user, entityId: row.id, organizationUserId: row.organizationUserId,
      notify: [{ userId: row.organizationUserId, title: was === 'pending' ? 'Member request cancelled' : 'A member left', body: was === 'pending' ? 'A member request was cancelled.' : 'A member left your organization.' }],
      staffBody: was === 'pending' ? 'A member request was cancelled.' : 'A member left an organization.' });
    return result({ membership: ownMembership(store, row, at) });
  }
  fail(404, 'not_found');
}

/** Only the count of a member's paid orders while a member this term, never what they ordered. */
async function orderCounts(database, organizationUserId, at) {
  const term = schoolYear(at);
  const { rows } = await database.query(`SELECT m.id, count(*)::int AS count FROM organization_memberships m
    JOIN users owner ON owner.id = m.organization_user_id
    JOIN orders o ON o.client_id = m.client_id AND o.state <> 'cancelled' AND o.review_data = owner.review_data
    WHERE m.organization_user_id = $1 AND m.status IN ('active','expired') AND m.term = $2
      AND o.commercial_committed_at >= GREATEST($3::timestamptz, (SELECT max((entry->>'approvedAt')::timestamptz) FROM jsonb_array_elements(m.data->'terms') entry WHERE entry->>'term' = $2))
      AND EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id AND p.code = 'initial' AND p.status = 'confirmed')
      AND ${activeOrderSql('o.id')} GROUP BY m.id`, [organizationUserId, term.code, term.startsAt]);
  return new Map(rows.map(row => [row.id, row.count]));
}
function officerMember(store, row, counts, at) {
  const perk = activePerk(store, row.organizationUserId, at);
  return { id: row.id, name: usersName(store, row.clientId), status: statusAt(row, at), memberSince: row.memberSince, source: row.source,
    term: publicTerm(row.term), termsCount: termsCount(row), requestedAt: row.requestedAt, version: row.version,
    ordersThisTerm: counts.get(row.id) ?? 0, perksUsed: perkUses(store, row).length, perksPerTerm: perk?.maxOrdersPerTerm ?? null };
}
async function results(store, database, organizationUserId, at) {
  const counts = await orderCounts(database, organizationUserId, at), term = schoolYear(at);
  const uses = (store.memberPerkUses || []).filter(row => row.organizationUserId === organizationUserId && row.term === term.code && row.status === 'confirmed');
  return { term: publicTerm(term.code), memberCount: liveMemberships(store, organizationUserId, at).length, membersOrdered: counts.size,
    memberOrders: [...counts.values()].reduce((total, count) => total + count, 0), membersSavedMinor: sumMinor(uses.map(row => row.amountMinor)) };
}
function page(url, items, size = 50) {
  const requested = Number(url.searchParams.get('limit') || size), limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : size;
  const after = url.searchParams.get('after'), start = after ? items.findIndex(row => row.id === after) + 1 : 0;
  const rows = items.slice(start, start + limit);
  return { rows, total: items.length, nextCursor: start + limit < items.length ? rows.at(-1).id : null };
}

async function routeOfficer({ req, url, path, store, user, input, database, at, id, secret, now }) {
  // The organization signs in with its one verified account; the person behind it
  // is the officer of record, so a handover keeps the same list under a new officer.
  const account = (store.organizationAccounts || []).find(row => row.userId === user.id);
  if (!account?.currentOfficer || user.role !== 'client') fail(403, 'officer_of_record_required');
  const partner = partnerFor(store, user.id);
  if (!partner) fail(403, 'organization_partner_required');
  const result = (body, status = 200, mutated = true) => ({ status, body, mutated });
  const term = schoolYear(at);
  const base = '/me/organization/members';
  const versioned = (row, body) => { if (row.version !== body.expectedVersion) fail(409, 'membership_stale', undefined, { currentVersion: row.version }); };

  if (path.startsWith('/me/organization/events')) return routeOrganizationEvents({ req, url, path, store, user, input, database, at, id, now });
  if (path === '/me/organization/partnership' && req.method === 'GET') {
    const perk = activePerk(store, user.id, at);
    return result({ partnership: { label: partner.label, partnerSince: partner.partnerSince, benefits: Object.fromEntries(BENEFITS.map(key => [key, partner.data.benefits?.[key] === true])),
      perk: perk ? { amountMinor: perk.amountMinor, maxOrdersPerTerm: perk.maxOrdersPerTerm, endsAt: perk.endsAt, setBy: 'GRIDGO', editable: false } : null,
      results: await results(store, database, user.id, at), events: await eventSummaries(database, store, user.id) } }, 200, false);
  }
  if (path === `${base}/summary` && req.method === 'GET') {
    const rows = rowsFor(store, user.id);
    return result({ label: partner.label, term: publicTerm(term.code), memberCount: liveMemberships(store, user.id, at).length,
      requestCount: rows.filter(row => row.status === 'pending').length, expiredCount: rows.filter(row => statusAt(row, at) === 'expired').length }, 200, false);
  }
  if (path === `${base}/invite` && ['GET', 'POST'].includes(req.method)) {
    let link = (await database.query('SELECT * FROM member_join_links WHERE organization_user_id = $1 AND term = $2', [user.id, term.code])).rows[0];
    let mutated = false;
    if (req.method === 'POST') {
      const body = await input();
      if (!link || body.replace === true) {
        link = (await database.query(`INSERT INTO member_join_links (organization_user_id, term, token, created_at) VALUES ($1,$2,$3,$4)
          ON CONFLICT (organization_user_id, term) DO UPDATE SET token = excluded.token, created_at = excluded.created_at RETURNING *`,
        [user.id, term.code, randomBytes(32).toString('base64url'), at])).rows[0];
        memberEvent(store, body.replace === true ? 'member_invite.replaced' : 'member_invite.created', { id, at, actor: user, entityType: 'organization', entityId: user.id,
          organizationUserId: user.id, detail: { term: term.code }, staffBody: 'An organization created its member link.' });
        mutated = true;
      }
    }
    // The QR carries the same path as the link; the app adds its own scheme or web origin.
    return result({ invite: link ? { term: publicTerm(term.code), token: link.token, path: `/join/${link.token}`, createdAt: link.created_at, expiresAt: term.endsAt } : null }, 200, mutated);
  }
  if (path === `${base}/requests` && req.method === 'GET') {
    const listed = page(url, rowsFor(store, user.id).filter(row => row.status === 'pending').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id)));
    return result({ requests: listed.rows.map(row => ({ id: row.id, name: usersName(store, row.clientId), source: row.source, requestedAt: row.requestedAt,
      term: publicTerm(row.term), memberSince: row.memberSince, termsCount: termsCount(row), version: row.version })), total: listed.total, nextCursor: listed.nextCursor }, 200, false);
  }
  if (path === base && req.method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all', status = url.searchParams.get('status') || 'active';
    if (!['all', 'ordered', 'not_ordered'].includes(filter) || !['active', 'expired', 'all'].includes(status)) fail(400, 'invalid_member_filter');
    const query = (url.searchParams.get('q') || '').trim().toLowerCase(), counts = await orderCounts(database, user.id, at);
    const listed = page(url, rowsFor(store, user.id).map(row => officerMember(store, row, counts, at))
      .filter(row => ['active', 'expired'].includes(row.status) && (status === 'all' || row.status === status) && (!query || row.name.toLowerCase().includes(query))
        && (filter === 'all' || (row.ordersThisTerm > 0) === (filter === 'ordered')))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
    return result({ term: publicTerm(term.code), members: listed.rows, total: listed.total, nextCursor: listed.nextCursor }, 200, false);
  }
  if (path === `${base}/list/check` && req.method === 'POST') return result({ check: await checkMemberList(database, partner, await input(), { at, secret }) }, 200, false);
  if (path === `${base}/list` && req.method === 'GET') return result(await listOpenEntries(database, user.id, at, url.searchParams.get('after') || ''), 200, false);
  if (path === `${base}/list` && req.method === 'POST') {
    const saved = await saveMemberList(database, partner, await input(), { at, id, secret });
    memberEvent(store, 'member_list.saved', { id, at, actor: user, entityType: 'organization', entityId: user.id, organizationUserId: user.id,
      detail: { term: term.code, rowCount: saved.rowCount, savedCount: saved.savedCount, consent: true }, staffBody: `A member list with ${saved.savedCount} new rows was saved.` });
    return result({ list: saved }, 201);
  }
  const entry = /^\/me\/organization\/members\/list\/([^/]+)$/.exec(path);
  if (entry && req.method === 'DELETE') {
    if (!await removeEntry(database, user.id, entry[1], at)) fail(404, 'member_list_entry_not_found');
    memberEvent(store, 'member_list.entry_removed', { id, at, actor: user, entityType: 'member_list_entry', entityId: entry[1], organizationUserId: user.id, staffBody: 'A member list row was removed.' });
    return result({ ok: true });
  }
  if (path === `${base}/renew` && req.method === 'POST') {
    const body = await input();
    if (!Array.isArray(body.memberIds) || !body.memberIds.length || body.memberIds.length > 500 || new Set(body.memberIds).size !== body.memberIds.length) fail(400, 'invalid_member_ids');
    const rows = body.memberIds.map(memberId => rowsFor(store, user.id).find(row => row.id === memberId) || fail(404, 'membership_not_found'));
    for (const row of rows) if (statusAt(row, at) !== 'expired') fail(409, 'membership_not_expired', undefined, { memberId: row.id });
    for (const row of rows) renew(row);
    return result({ renewed: rows.map(row => row.id), term: publicTerm(term.code) });
  }
  function renew(row) {
    activate(store, row, { memberSince: row.memberSince, term, by: user.id, at });
    memberEvent(store, 'membership.renewed', { id, at, actor: user, entityId: row.id, organizationUserId: user.id, detail: { term: term.code },
      notify: [{ userId: row.clientId, title: 'Membership renewed', body: `Your ${partner.label} membership is renewed for ${term.label}.` }], staffBody: 'A membership was renewed.' });
  }
  const item = /^\/me\/organization\/members\/([^/]+)(?:\/(approve|decline|renew))?$/.exec(path);
  if (!item) fail(404, 'not_found');
  const row = rowsFor(store, user.id).find(member => member.id === item[1]);
  if (!row) fail(404, 'membership_not_found');
  const view = async () => ({ member: officerMember(store, row, await orderCounts(database, user.id, at), at) });
  if (!item[2] && req.method === 'GET') return result(await view(), 200, false);
  if (!item[2] && req.method === 'PATCH') {
    const body = await input();
    versioned(row, body);
    if (!['active', 'expired'].includes(statusAt(row, at))) fail(409, 'membership_not_active');
    const memberSince = parseMemberSince(body.memberSince, at) || fail(400, 'invalid_member_since');
    const before = { memberSince: row.memberSince };
    row.memberSince = memberSince; bump(row, at);
    memberEvent(store, 'membership.date_edited', { id, at, actor: user, entityId: row.id, organizationUserId: user.id, before, after: { memberSince },
      notify: [{ userId: row.clientId, title: 'Member since updated', body: `${partner.label} updated your member since date.` }], staffBody: 'A member since date was edited.' });
    return result(await view());
  }
  if (!item[2] && req.method === 'DELETE') {
    const body = await input();
    versioned(row, body);
    if (!['active', 'expired'].includes(statusAt(row, at))) fail(409, 'membership_not_active');
    removeMembership(row, 'removed_by_officer', at, user.id);
    await closeClientEntries(database, user.id, row.clientId, 'removed', at);
    memberEvent(store, 'membership.removed', { id, at, actor: user, entityId: row.id, organizationUserId: user.id,
      notify: [{ userId: row.clientId, title: 'Membership ended', body: `Your ${partner.label} membership ended. Your past orders stay as they are.` }], staffBody: 'A member was removed.' });
    return result({ ok: true });
  }
  if (item[2] === 'approve' && req.method === 'POST') {
    const body = await input();
    versioned(row, body);
    if (row.status !== 'pending') fail(409, 'membership_not_pending');
    if (body.term != null && body.term !== term.code) fail(400, 'invalid_member_term');
    const memberSince = parseMemberSince(body.memberSince, at) || fail(400, 'invalid_member_since');
    activate(store, row, { memberSince, term, by: user.id, at });
    await closeClientEntries(database, user.id, row.clientId, 'accepted', at);
    memberEvent(store, 'membership.approved', { id, at, actor: user, entityId: row.id, organizationUserId: user.id, detail: { term: term.code, source: row.source },
      notify: [{ userId: row.clientId, title: 'You are a member', body: `You are now a ${partner.label} member.` }], staffBody: 'A member request was approved.' });
    return result(await view());
  }
  if (item[2] === 'decline' && req.method === 'POST') {
    const body = await input();
    versioned(row, body);
    if (row.status !== 'pending') fail(409, 'membership_not_pending');
    removeMembership(row, 'declined', at, user.id);
    memberEvent(store, 'membership.declined', { id, at, actor: user, entityId: row.id, organizationUserId: user.id,
      notify: [{ userId: row.clientId, title: 'Member request declined', body: `${partner.label} did not approve your request.` }], staffBody: 'A member request was declined.' });
    return result({ ok: true });
  }
  if (item[2] === 'renew' && req.method === 'POST') {
    const body = await input();
    versioned(row, body);
    if (statusAt(row, at) !== 'expired') fail(409, 'membership_not_expired');
    renew(row);
    return result(await view());
  }
  fail(404, 'not_found');
}

function perkInput(body, at) {
  const integer = (key, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(body[key]) && body[key] >= min && body[key] <= max ? body[key] : fail(400, 'invalid_member_perk', undefined, { field: key });
  if (typeof body.enabled !== 'boolean') fail(400, 'invalid_member_perk', undefined, { field: 'enabled' });
  const ends = typeof body.endsAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(body.endsAt) ? Date.parse(body.endsAt) : NaN;
  if (!Number.isFinite(ends) || body.enabled && ends <= Date.parse(at)) fail(400, 'invalid_member_perk', undefined, { field: 'endsAt' });
  return { enabled: body.enabled, amountMinor: integer('amountMinor', 1), maxOrdersPerTerm: integer('maxOrdersPerTerm', 1, 1000),
    endsAt: new Date(ends).toISOString(), budgetCapMinor: integer('budgetCapMinor', 1) };
}
const reasonText = body => typeof body.reason === 'string' && body.reason.trim() && body.reason.length <= 2000 ? body.reason.trim() : fail(400, 'reason_required');
const publicPerk = row => row && { enabled: row.enabled, amountMinor: row.amountMinor, maxOrdersPerTerm: row.maxOrdersPerTerm, endsAt: row.endsAt, budgetCapMinor: row.budgetCapMinor,
  version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy };

/** GRIDGO's side: partners, the perk, and totals. No member name, list row or contact is read here. */
async function routeStaff({ req, path, store, user, input, database, at, id }) {
  const admin = user.role === 'super_admin' && identityHasMembership(user, 'super_admin');
  if (!admin && !(user.role === 'ops_admin' && identityHasMembership(user, 'ops_admin'))) fail(403, 'forbidden');
  if (req.method !== 'GET' && !admin) fail(403, 'forbidden');
  const result = (body, status = 200, mutated = true) => ({ status, body, mutated });
  store.memberPerkSettings ||= []; store.organizationPartners ||= [];
  const standard = () => store.memberPerkSettings.find(row => row.id === 'standard');
  const partnerView = async row => ({ userId: row.userId, organizationName: (store.organizationAccounts || []).find(account => account.userId === row.userId)?.name || null,
    label: row.label, status: row.status, live: Boolean(partnerFor(store, row.userId)), partnerSince: row.partnerSince, version: row.version,
    benefits: Object.fromEntries(BENEFITS.map(key => [key, row.data.benefits?.[key] === true])),
    perkOverride: publicPerk(store.memberPerkSettings.find(perk => perk.organizationUserId === row.userId)) ?? null,
    perk: publicPerk(activePerk(store, row.userId, at)) ?? null, budgetUsedMinor: perkSpentMinor(store, row.userId),
    budgetLeftMinor: perkSettingFor(store, row.userId) ? Math.max(0, perkSettingFor(store, row.userId).budgetCapMinor - perkSpentMinor(store, row.userId)) : null,
    results: await results(store, database, row.userId, at) });
  const setPerk = (key, organizationUserId, body) => {
    const why = reasonText(body), values = perkInput(body, at);
    let row = store.memberPerkSettings.find(perk => perk.id === key);
    if ((row?.version ?? 0) !== body.expectedVersion) fail(409, 'member_perk_stale', undefined, { currentVersion: row?.version ?? 0 });
    const before = publicPerk(row) ?? null;
    if (!row) { row = { id: key, organizationUserId, version: 0 }; store.memberPerkSettings.push(row); }
    Object.assign(row, values, { version: row.version + 1, updatedAt: at, updatedBy: user.id });
    memberEvent(store, 'member_perk.set', { id, at, actor: user, entityType: 'member_perk', entityId: key, organizationUserId, reason: why, before, after: publicPerk(row),
      staffBody: organizationUserId ? 'A member perk override was set.' : 'The standard member perk was set.' });
    return row;
  };
  if (path === '/ops/member-perk' && req.method === 'GET') return result({ standard: publicPerk(standard()) ?? null }, 200, false);
  if (path === '/ops/member-perk' && req.method === 'PUT') return result({ standard: publicPerk(setPerk('standard', null, await input())) });
  if (path === '/ops/organization-partners' && req.method === 'GET') {
    return result({ partners: await Promise.all([...store.organizationPartners].sort((a, b) => a.label.localeCompare(b.label) || a.userId.localeCompare(b.userId)).map(partnerView)) }, 200, false);
  }
  const item = /^\/ops\/organization-partners\/([^/]+)(\/perk)?$/.exec(path);
  if (!item) fail(404, 'not_found');
  const organizationUserId = decodeURIComponent(item[1]);
  let row = store.organizationPartners.find(partner => partner.userId === organizationUserId);
  if (item[2]) {
    if (!row) fail(404, 'organization_partner_not_found');
    if (req.method === 'PUT') { setPerk(organizationUserId, organizationUserId, await input()); return result({ partner: await partnerView(row) }); }
    if (req.method === 'DELETE') {
      const body = await input(), why = reasonText(body), perk = store.memberPerkSettings.find(setting => setting.id === organizationUserId);
      if (!perk) fail(404, 'member_perk_override_not_found');
      if (perk.version !== body.expectedVersion) fail(409, 'member_perk_stale', undefined, { currentVersion: perk.version });
      store.memberPerkSettings = store.memberPerkSettings.filter(setting => setting !== perk);
      memberEvent(store, 'member_perk.override_removed', { id, at, actor: user, entityType: 'member_perk', entityId: organizationUserId, organizationUserId, reason: why,
        before: publicPerk(perk), after: null, staffBody: 'A member perk override was removed.' });
      return result({ partner: await partnerView(row) });
    }
    fail(404, 'not_found');
  }
  if (req.method === 'GET') return row ? result({ partner: await partnerView(row) }, 200, false) : fail(404, 'organization_partner_not_found');
  if (req.method !== 'PUT') fail(404, 'not_found');
  const body = await input(), why = reasonText(body);
  const account = (store.organizationAccounts || []).find(entry => entry.userId === organizationUserId);
  if (!account?.currentOfficer) fail(409, 'verified_organization_required');
  if ((row?.version ?? 0) !== body.expectedVersion) fail(409, 'organization_partner_stale', undefined, { currentVersion: row?.version ?? 0 });
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 40) fail(400, 'invalid_partner_label');
  if (!['active', 'ended'].includes(body.status)) fail(400, 'invalid_partner_status');
  const partnerSince = parseMemberSince(body.partnerSince, at) || fail(400, 'invalid_partner_since');
  if (body.benefits != null && (typeof body.benefits !== 'object' || Array.isArray(body.benefits)
    || Object.entries(body.benefits).some(([key, value]) => !BENEFITS.includes(key) || typeof value !== 'boolean'))) fail(400, 'invalid_partner_benefits');
  const before = row ? { label: row.label, status: row.status, partnerSince: row.partnerSince, benefits: row.data.benefits } : null;
  if (!row) { row = { userId: organizationUserId, version: 0, createdAt: at, data: {} }; store.organizationPartners.push(row); }
  Object.assign(row, { label, status: body.status, partnerSince, version: row.version + 1, updatedAt: at, data: { ...row.data, benefits: body.benefits ?? row.data.benefits ?? {} } });
  if (body.status === 'active' && !partnerFor(store, organizationUserId)) fail(409, 'verified_organization_required');
  if (body.status === 'ended') await closeOrganizationEntries(database, organizationUserId, at);
  memberEvent(store, 'organization_partner.set', { id, at, actor: user, entityType: 'organization', entityId: organizationUserId, organizationUserId, reason: why, before,
    after: { label, status: row.status, partnerSince, benefits: row.data.benefits },
    notify: [{ userId: organizationUserId, title: row.status === 'active' ? 'GRIDGO partner organization' : 'Partnership ended',
      body: row.status === 'active' ? 'Your organization is a GRIDGO partner. Open Members to invite your members.' : 'Your GRIDGO partnership ended. Past orders stay as they are.' }],
    staffBody: 'An organization partnership was updated.' });
  return result({ partner: await partnerView(row) });
}

export async function routeOrganizationMembers({ req, url, store, user, readBody, database, now, id, secret, clerk }) {
  const path = url.pathname;
  if (!isMemberRoute(path)) return null;
  if (!user) fail(401, 'unauthorized');
  const at = now();
  const input = async () => {
    const body = await readBody(req);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : fail(400, 'invalid_request');
  };
  store.organizationMemberships ||= [];
  const args = { req, url, path, store, user, input, database, at, id, secret, now, clerk };
  if (STAFF.test(path)) return routeStaff(args);
  if (!identityHasMembership(user, 'client')) fail(403, 'membership_required');
  return OFFICER.test(path) ? routeOfficer(args) : routeClient(args);
}

/** Term end: memberships expire, unanswered requests lapse, unclaimed list contacts are redacted. */
export async function sweepMembers(store, database, { at, id }) {
  await sweepMemberList(database, at);
  let changed = false;
  for (const row of store.organizationMemberships || []) {
    if (!['pending', 'active'].includes(row.status) || Date.parse(row.termEndsAt) > Date.parse(at)) continue;
    changed = true;
    if (row.status === 'pending') { removeMembership(row, 'request_expired', at, null); memberEvent(store, 'membership.request_expired', { id, at, entityId: row.id, organizationUserId: row.organizationUserId,
      notify: [{ userId: row.clientId, title: 'Member request closed', body: 'The term ended before your request was answered.' }], staffBody: 'A member request lapsed at term end.' }); continue; }
    row.status = 'expired'; bump(row, at);
    memberEvent(store, 'membership.expired', { id, at, entityId: row.id, organizationUserId: row.organizationUserId, detail: { term: row.term },
      notify: [{ userId: row.clientId, title: 'Membership term ended', body: `Your ${perkLabel(store, row.organizationUserId)} term ended. The officer can renew it.` }], staffBody: 'A membership term ended.' });
  }
  return changed;
}
