import { randomUUID } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { createTesterGoogleGroup } from './tester-google-group.js';
import { hasKnownPlayInstall, knownPlayInstallSql } from './play-install.js';

const APPS = ['client', 'supplier', 'rider'];
const googleGroup = createTesterGoogleGroup();
const ok = body => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });
export const PLAY_OPTIN_COPY = 'Help us launch GRIDGO on Play, become a tester.';
export const PLAY_SETTING_KEYS = ['campaignEnabled', 'optInUrl', 'groupJoinUrl', 'target', 'dailyReminderEnabled', 'dailyReminderHour'];
export function isPlayOptinRoute(path) {
  return /^\/me\/play-optin(?:\/(?:confirm-gmail|event))?$/.test(path)
    || path === '/ops/testers/broadcast' || /^\/ops\/testers\/[^/]+\/[^/]+\/opt-in$/.test(path);
}
export const playDefaults = app => ({ app, campaign_enabled: false, opt_in_url: `https://play.google.com/apps/testing/ph.gridgo.${app}`,
  group_join_url: null, target: 12, daily_reminder_enabled: true, daily_reminder_hour: 10 });
export async function playConfig(database, app) {
  const config = { ...playDefaults(app), ...(await database.query('SELECT * FROM tester_program_settings WHERE app=$1', [app])).rows[0] };
  config.opt_in_url ||= playDefaults(app).opt_in_url;
  return config;
}
const publicConfig = (config, groups) => ({ campaignEnabled: config.campaign_enabled, optInUrl: config.opt_in_url,
  groupJoinUrl: config.group_join_url, target: config.target, dailyReminderEnabled: config.daily_reminder_enabled, dailyReminderHour: config.daily_reminder_hour, groupMode: groups.configured(config.app) ? 'automatic' : 'link' });
export function validatePlaySettings(body) {
  if (body.campaignEnabled !== undefined && typeof body.campaignEnabled !== 'boolean') return 'invalid_campaign_enabled';
  if (body.dailyReminderEnabled !== undefined && typeof body.dailyReminderEnabled !== 'boolean') return 'invalid_daily_reminder_enabled';
  if (body.dailyReminderHour !== undefined && (!Number.isInteger(body.dailyReminderHour) || body.dailyReminderHour < 0 || body.dailyReminderHour > 23)) return 'invalid_daily_reminder_hour';
  if (body.target !== undefined && (!Number.isInteger(body.target) || body.target < 1 || body.target > 10000)) return 'invalid_target';
  for (const [field, host] of [['optInUrl', 'play.google.com'], ['groupJoinUrl', 'groups.google.com']]) {
    if (body[field] === undefined || (field === 'groupJoinUrl' && body[field] === null)) continue;
    try {
      if (typeof body[field] !== 'string' || body[field].length > 2048 || /[\s\x00-\x1f\x7f]/.test(body[field])) return `invalid_${field === 'optInUrl' ? 'opt_in_url' : 'group_join_url'}`;
      const url = new URL(body[field]);
      if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password
        || (field === 'optInUrl' && !/^\/apps\/testing\/[a-zA-Z0-9_.]+$/.test(url.pathname))
        || (field === 'groupJoinUrl' && !/^\/(?:a\/[^/]+\/)?g\/[^/]+(?:\/.*)?$/.test(url.pathname))) throw new Error();
    } catch { return field === 'optInUrl' ? 'invalid_opt_in_url' : 'invalid_group_join_url'; }
  }
  return null;
}
export async function writePlaySettings(database, app, body) {
  const previous = await playConfig(database, app);
  await database.query(`UPDATE tester_program_settings SET campaign_enabled=$2,opt_in_url=$3,group_join_url=$4,target=$5,daily_reminder_enabled=$6,daily_reminder_hour=$7 WHERE app=$1`,
    [app, body.campaignEnabled ?? previous.campaign_enabled, body.optInUrl ?? previous.opt_in_url,
      body.groupJoinUrl === undefined ? previous.group_join_url : body.groupJoinUrl, body.target ?? previous.target,
      body.dailyReminderEnabled ?? previous.daily_reminder_enabled, body.dailyReminderHour ?? previous.daily_reminder_hour]);
}
export function validGoogleEmail(email, googleAccount) {
  if (typeof email !== 'string' || email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(email)) return false;
  const [local, domain] = email.toLowerCase().split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return ['gmail.com', 'googlemail.com'].includes(domain) || googleAccount === true;
}
export const playEligible = (config, row, platform, channel, knownPlayInstall = false) => Boolean(config.campaign_enabled && !config.production_approved_at
  && platform === 'android' && channel !== 'play' && !knownPlayInstall && !row?.opted_in_at && (row?.dismiss_count || 0) < 3);
const stepFor = row => row?.opted_in_at ? 'opted_in' : row?.optin_opened_at ? 'install_from_play'
  : row?.group_joined_at || row?.group_opened_at ? 'open_optin' : row?.email ? 'join_group' : 'confirm_gmail';
async function ownRow(database, userId, app) {
  return (await database.query('SELECT * FROM tester_program_play_optins WHERE user_id=$1 AND app=$2', [userId, app])).rows[0];
}
async function ensureRow(database, userId, app, at) {
  await database.query(`INSERT INTO tester_program_settings(app,opt_in_url) VALUES($1,$2) ON CONFLICT DO NOTHING`, [app, playDefaults(app).opt_in_url]);
  await database.query(`INSERT INTO tester_program_play_optins(user_id,app,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, app, at]);
}
async function markOptedIn(database, userId, app, at, source, actor, auditEvent) {
  const row = await ownRow(database, userId, app);
  if (row.opted_in_at) return;
  await database.query(`UPDATE tester_program_play_optins SET opted_in_at=$3,opted_in_source=$4,updated_at=$3 WHERE user_id=$1 AND app=$2`, [userId, app, at, source]);
  // Opt-in is independent of staff enrollment. A prior explicit removal can
  // only be reversed by POST /ops/testers, never by install telemetry or a mark.
  const id = randomUUID();
  const enrolled = await database.query(`INSERT INTO tester_program_enrollments(id,user_id,app,added_at,added_by)
    SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (
      SELECT 1 FROM tester_program_enrollments WHERE user_id=$2 AND app=$3 AND removed_at IS NOT NULL
    ) ON CONFLICT(user_id,app) WHERE removed_at IS NULL DO NOTHING RETURNING id`, [id, userId, app, at, actor.id]);
  if (enrolled.rowCount) await auditEvent({ actor, action: 'tester_program.enrolled', entityType: 'tester_program', entityId: id, detail: { userId, app, source } });
  await auditEvent({ actor, action: 'tester_program.play_opted_in', entityType: 'tester_program', entityId: userId, detail: { app, source } });
}
export async function playOpsRead(database, app, groups = googleGroup) {
  const config = await playConfig(database, app);
  const { rows: [counts] } = await database.query(`SELECT count(*) FILTER(WHERE opted_in_at IS NOT NULL)::int AS total,
    count(*) FILTER(WHERE opted_in_source='play_channel')::int AS detected FROM tester_program_play_optins WHERE app=$1`, [app]);
  const unfinished = (await database.query(`SELECT p.*,u.name FROM tester_program_play_optins p JOIN users u ON u.id=p.user_id
    WHERE p.app=$1 AND p.opted_in_at IS NULL AND (p.tapped_at IS NOT NULL OR p.gmail_confirmed_at IS NOT NULL OR p.group_opened_at IS NOT NULL OR p.optin_opened_at IS NOT NULL)
    ORDER BY GREATEST(p.tapped_at,p.gmail_confirmed_at,p.group_joined_at,p.group_opened_at,p.optin_opened_at) DESC,p.user_id LIMIT 500`, [app])).rows.map(row => ({ userId: row.user_id, name: row.name, app,
    gmail: row.email, lastStep: stepFor(row), at: [row.tapped_at,row.gmail_confirmed_at,row.group_joined_at,row.group_opened_at,row.optin_opened_at].filter(Boolean).sort().at(-1) }));
  return { ...publicConfig(config, groups), optedInCount: counts.total, detectedPlayCount: counts.detected,
    playConsoleOptedInCount: config.opted_in_count ?? 0, unfinished };
}

/** Both the Console figure and recorded opt-ins can stop a finished campaign. */
export const playBelowTargetSql = (alias = 's') => `GREATEST(${alias}.opted_in_count,
  (SELECT count(*) FROM tester_program_play_optins finished WHERE finished.app=${alias}.app AND finished.opted_in_at IS NOT NULL)) < ${alias}.target`;
async function playCampaignBelowTarget(database, app) {
  return Boolean((await database.query(`SELECT 1 FROM tester_program_settings s WHERE app=$1 AND ${playBelowTargetSql()}`, [app])).rowCount);
}

/** Caller holds the domain transaction; the daily claims and outbox commit together. */
async function queuePlayOptinBroadcast({ database, app, actor, at, broadcast }) {
  // A pre-upgrade API can write a manual announcement after migration's
  // backfill. Adopt those committed notifications under the same domain lock.
  await database.query(`WITH day AS (
      SELECT ($2::timestamptz AT TIME ZONE 'Asia/Manila')::date AS manila_date
    ) INSERT INTO tester_program_play_reminder_recipients(app,manila_date,user_id,queued_at)
    SELECT $1,day.manila_date,n.user_id,min(n.created_at)
    FROM notifications n CROSS JOIN day
    WHERE n.type='play_optin' AND n.data->>'appRole'=$1
      AND n.created_at >= (day.manila_date::timestamp AT TIME ZONE 'Asia/Manila')
      AND n.created_at < ((day.manila_date+1)::timestamp AT TIME ZONE 'Asia/Manila')
    GROUP BY day.manila_date,n.user_id ON CONFLICT DO NOTHING`, [app, at]);
  const recipients = (await database.query(`INSERT INTO tester_program_play_reminder_recipients(app,manila_date,user_id,queued_at)
    SELECT DISTINCT $1,($2::timestamptz AT TIME ZONE 'Asia/Manila')::date,u.id,$2::timestamptz FROM users u
    JOIN user_role_memberships m ON m.user_id=u.id AND m.role=$1
    JOIN device_tokens d ON d.user_id=u.id AND d.platform='android' AND d.data->>'appRole'=$1
    LEFT JOIN tester_program_play_optins p ON p.user_id=u.id AND p.app=$1
    WHERE COALESCE(d.data->>'installChannel','apk') <> 'play' AND p.opted_in_at IS NULL
      AND COALESCE(p.dismiss_count,0)<3
      AND NOT ${knownPlayInstallSql('u.id', '$1')}
    ON CONFLICT DO NOTHING RETURNING user_id`, [app, at])).rows.map(row => row.user_id);
  return broadcast({ app, recipientIds: recipients, actor, at });
}

/** Existing lifecycle tick: catch up today's run after its Manila hour, never replay past days. */
export async function runPlayOptinReminders({ database, broadcast, now = () => new Date().toISOString(), groups = googleGroup }) {
  const probeAt = now();
  const dueSql = `s.campaign_enabled AND s.production_approved_at IS NULL AND s.daily_reminder_enabled
    AND s.daily_reminder_hour <= EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE 'Asia/Manila')
    AND ${playBelowTargetSql()}
    AND NOT EXISTS (SELECT 1 FROM tester_program_play_reminder_runs r WHERE r.app=s.app
      AND r.manila_date=($1::timestamptz AT TIME ZONE 'Asia/Manila')::date)`;
  // Probe without taking the domain lock on every idle lifecycle tick.
  const candidates = (await database.query(`SELECT s.app FROM tester_program_settings s WHERE ${dueSql}`, [probeAt])).rows;
  for (const { app } of candidates) await database.transaction(async () => {
    // Lock waits can cross midnight. Recompute the hour/date from the clock
    // only after this transaction owns the domain lock.
    const at = now();
    const config = (await database.query(`SELECT s.* FROM tester_program_settings s WHERE s.app=$2 AND ${dueSql}`, [at, app])).rows[0];
    if (!config || (!groups.configured(app) && !config.group_join_url)) return;
    const claimed = await database.query(`INSERT INTO tester_program_play_reminder_runs(app,manila_date,queued_at)
      VALUES($1,($2::timestamptz AT TIME ZONE 'Asia/Manila')::date,$2) ON CONFLICT DO NOTHING RETURNING app`, [app, at]);
    if (!claimed.rowCount) return;
    await queuePlayOptinBroadcast({ database, app, actor: { role: 'system' }, at, broadcast });
  });
}

/** Channel is install telemetry, never Google verification or an authorization grant. */
export async function routePlayOptin({ req, url, user, database, readBody, auditEvent, broadcast,
  now = () => new Date().toISOString(), groups = googleGroup }) {
  if (!isPlayOptinRoute(url.pathname)) return null;
  if (!user) return fail(401, 'unauthorized');
  const ops = url.pathname.startsWith('/ops/');
  if (ops && !['ops_admin','super_admin'].some(role => identityHasMembership(user, role))) return fail(403, 'forbidden');
  const read = req.method === 'GET' && url.pathname === '/me/play-optin';
  if (!read && req.method !== 'POST') return fail(404, 'not_found');
  const body = read ? {} : await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_request');
  const mark = /^\/ops\/testers\/[^/]+\/[^/]+\/opt-in$/.test(url.pathname);
  const app = read ? url.searchParams.get('app') : mark ? url.pathname.split('/')[3] : body.app;
  if (!APPS.includes(app)) return fail(400, 'invalid_app');
  if (!ops && !identityHasMembership(user, app)) return fail(403, 'forbidden');
  const platform = read ? url.searchParams.get('platform') : body.platform;
  const channel = read ? url.searchParams.get('channel') : body.channel;
  if (!ops && (!['android','ios','web'].includes(platform) || !['play','sideload'].includes(channel))) return fail(400, 'invalid_install');
  return database.transaction(async () => {
    const at = now();
    const config = await playConfig(database, app);
    if (ops) {
      if (mark) {
        let target;
        try { target = decodeURIComponent(url.pathname.split('/')[4]); } catch { return fail(400, 'invalid_user_id'); }
        if (!target || target.includes('\0')) return fail(400, 'invalid_user_id');
        if (!(await database.query('SELECT 1 FROM user_role_memberships WHERE user_id=$1 AND role=$2', [target, app])).rowCount) return fail(404, 'user_not_found');
        await ensureRow(database, target, app, at);
        await markOptedIn(database, target, app, at, 'operations', user, auditEvent);
        return ok({ ok: true });
      }
      if (!config.campaign_enabled || config.production_approved_at) return fail(409, 'campaign_disabled');
      if (!groups.configured(app) && !config.group_join_url) return fail(409, 'group_not_configured');
      if (!await playCampaignBelowTarget(database, app)) return fail(409, 'campaign_target_reached');
      const announcement = await queuePlayOptinBroadcast({ database, app, actor: user, at, broadcast });
      return { status: 201, body: { announcement } };
    }
    const knownPlayInstall = await hasKnownPlayInstall(database, user.id, app);
    if (read) {
      await ensureRow(database, user.id, app, at);
      await database.query(`UPDATE tester_program_play_optins SET last_channel=$3,last_platform=$4,updated_at=$5 WHERE user_id=$1 AND app=$2`, [user.id, app, channel, platform, at]);
      if (knownPlayInstall || (platform === 'android' && channel === 'play')) await markOptedIn(database, user.id, app, at, 'play_channel', user, auditEvent);
    }
    const row = await ownRow(database, user.id, app);
    const state = () => ({ app, show: playEligible(config, row, platform, channel, knownPlayInstall), step: stepFor(row),
      gmailSuggestion: row?.email || user.email || null, ...publicConfig(config, groups), optedIn: Boolean(row?.opted_in_at),
      dismissCount: row?.dismiss_count || 0, playStoreUrl: `https://play.google.com/store/apps/details?id=ph.gridgo.${app}` });
    if (read) return ok(state());
    if (!playEligible(config, row, platform, channel, knownPlayInstall)) return fail(409, 'campaign_not_available');
    if (!row) return fail(409, 'install_not_reported');
    if (url.pathname.endsWith('/confirm-gmail')) {
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : body.email;
      if (!validGoogleEmail(email, body.googleAccount)) return fail(400, 'invalid_gmail');
      const automatic = groups.configured(app);
      if (!automatic && !config.group_join_url) return fail(409, 'group_not_configured');
      // A provider failure never advances the recorded group step. Repeating a
      // successful add is safe (Directory's already-member response is accepted).
      if (automatic) {
        try { await groups.addMember(app, email); } catch { return fail(503, 'google_group_unavailable'); }
      }
      await database.query(`UPDATE tester_program_play_optins SET email=$3,gmail_confirmed_at=$4,
        group_joined_at=$5,group_opened_at=CASE WHEN email=$3 THEN group_opened_at ELSE NULL END,
        optin_opened_at=CASE WHEN email=$3 THEN optin_opened_at ELSE NULL END,updated_at=$4 WHERE user_id=$1 AND app=$2`,
      [user.id, app, email, at, automatic ? at : null]);
      return ok({ ...state(), step: automatic ? 'open_optin' : 'join_group', gmailSuggestion: email });
    }
    if (url.pathname.endsWith('/event')) {
      const columns = { shown: 'shown_at', tapped: 'tapped_at', group_opened: 'group_opened_at', optin_opened: 'optin_opened_at' };
      if (!['shown','dismissed',...Object.keys(columns)].includes(body.type)) return fail(400, 'invalid_event');
      if (['group_opened','optin_opened'].includes(body.type) && !row.gmail_confirmed_at) return fail(409, 'gmail_not_confirmed');
      if (body.type === 'optin_opened' && !row.group_joined_at && !row.group_opened_at) return fail(409, 'group_step_required');
      if (body.type === 'group_opened' && !config.group_join_url) return fail(409, 'group_not_configured');
      if (body.type === 'dismissed') await database.query(`UPDATE tester_program_play_optins SET dismiss_count=LEAST(3,dismiss_count+1),updated_at=$3 WHERE user_id=$1 AND app=$2`, [user.id, app, at]);
      else await database.query(`UPDATE tester_program_play_optins SET ${columns[body.type]}=COALESCE(${columns[body.type]},$3),updated_at=$3 WHERE user_id=$1 AND app=$2`, [user.id, app, at]);
      return ok({ ok: true });
    }
    return fail(404, 'not_found');
  });
}
