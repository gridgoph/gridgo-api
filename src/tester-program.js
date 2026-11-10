import { randomUUID } from 'node:crypto';
import { identityHasMembership } from './authorization-context.js';
import { isPlayOptinRoute, routePlayOptin, playOpsRead, PLAY_SETTING_KEYS, validatePlaySettings, writePlaySettings } from './play-optin.js';

const APPS = ['client', 'supplier', 'rider'];
const DAY_MS = 86_400_000;
const COOLDOWN_MS = 3 * DAY_MS;
const TRIGGERS = ['streak_3', 'streak_7', 'streak_10', 'streak_14', 'completed_order'];
const fail = (status, error) => ({ status, body: { error } });
const ok = body => ({ status: 200, body });
export const manilaDate = at => new Date(new Date(at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
export const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dateDistance = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !value.startsWith('0000-') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function testerProgress(enrollment, dates, today) {
  const checked = new Set(dates);
  const checkedInToday = checked.has(today);
  const runComplete = Boolean(enrollment.completed_at);
  let streak = 0;
  for (let day = checkedInToday ? today : shiftDate(today, -1); checked.has(day); day = shiftDate(day, -1)) streak++;
  if (runComplete) streak = 14;
  return { day: runComplete ? 14 : Math.min(14, checkedInToday ? streak : streak + 1), streak, checkedInToday, runComplete };
}

export function testerDayBoxes(enrollment, dates, today) {
  const checked = new Set(dates);
  const end = enrollment.completed_at ? manilaDate(enrollment.completed_at) : today;
  const start = manilaDate(enrollment.added_at);
  return Array.from({ length: 14 }, (_, index) => {
    const date = shiftDate(end, index - 13);
    return { date, state: date < start ? 'before_start' : checked.has(date) ? 'checked_in' : date === today ? 'today' : 'missed' };
  });
}

export function isTesterProgramRoute(pathname) {
  return isPlayOptinRoute(pathname) || /^\/me\/tester-program(?:\/(?:check-in|feedback))?$/.test(pathname)
    || pathname === '/ops/testers' || pathname === '/ops/testers/settings'
    || /^\/ops\/testers\/[^/]+\/[^/]+$/.test(pathname);
}

async function settings(database, app) {
  return (await database.query('SELECT * FROM tester_program_settings WHERE app=$1', [app])).rows[0]
    || { play_clock_start_date: null, opted_in_count: 0, production_approved_at: null };
}
async function enrollmentFor(database, userId, app) {
  return (await database.query('SELECT * FROM tester_program_enrollments WHERE user_id=$1 AND app=$2 AND removed_at IS NULL', [userId, app])).rows[0];
}
async function checkinsFor(database, enrollmentId) {
  return (await database.query(`SELECT c.* FROM tester_program_checkins c JOIN tester_program_enrollment_days d ON d.checkin_id=c.id
    WHERE d.enrollment_id=$1 ORDER BY c.manila_date`, [enrollmentId])).rows;
}
async function feedbackFor(database, userId, app) {
  // A tap stops feedback forever for this account/app, including re-enrolments.
  return (await database.query('SELECT * FROM tester_program_feedback WHERE user_id=$1 AND app=$2 ORDER BY shown_at DESC, id DESC', [userId, app])).rows;
}

async function completedOrderFor(database, enrollment, latest, at) {
  return (await database.query(`SELECT o.id FROM orders o WHERE o.state IN ('completed','payout_released')
    AND o.updated_at > $2::timestamptz AND o.updated_at <= $3::timestamptz
    AND NOT EXISTS (SELECT 1 FROM tester_program_feedback f WHERE f.user_id=$1 AND f.app=$4 AND f.order_id=o.id)
    AND (($4='client' AND o.client_id=$1) OR ($4='rider' AND (o.rider_id=$1
      OR EXISTS (SELECT 1 FROM order_jobs j WHERE j.order_id=o.id AND j.rider_id=$1)))
      OR ($4='supplier' AND (o.supplier_id=$1 OR EXISTS (SELECT 1 FROM order_jobs j WHERE j.order_id=o.id AND j.supplier_id=$1))))
    ORDER BY o.updated_at DESC, o.id LIMIT 1`,
  [enrollment.user_id, latest?.shown_at || enrollment.added_at, at, enrollment.app])).rows[0];
}

async function nudgeFor(database, enrollment, progress, config, feedback, at) {
  if (config.production_approved_at || feedback.some(row => row.tapped_at)) return null;
  const latest = feedback[0];
  if (latest && Date.parse(at) - Date.parse(latest.shown_at) < COOLDOWN_MS) return null;
  const trigger = `streak_${progress.streak}`;
  if (progress.checkedInToday && TRIGGERS.includes(trigger)) return { trigger };
  // Observe existing completion facts; never hook or mutate order processing.
  // A shown prompt consumes completions up to its timestamp, so one old order
  // cannot repeatedly trigger prompts after every cooldown.
  return await completedOrderFor(database, enrollment, latest, at) ? { trigger: 'completed_order' } : null;
}

async function ownState(database, enrollment, config, at) {
  const today = manilaDate(at);
  const rows = await checkinsFor(database, enrollment.id);
  const progress = testerProgress(enrollment, rows.map(row => row.manila_date), today);
  return { enrolled: true, app: enrollment.app, ...progress,
    stopped: progress.runComplete || Boolean(config.production_approved_at),
    productionApproved: Boolean(config.production_approved_at), manilaDate: today,
    nudge: await nudgeFor(database, enrollment, progress, config, await feedbackFor(database, enrollment.user_id, enrollment.app), at) };
}

async function opsRead(database, app, at) {
  const today = manilaDate(at);
  const config = await settings(database, app);
  const enrollments = (await database.query(`SELECT e.*, u.name, u.email FROM tester_program_enrollments e JOIN users u ON u.id=e.user_id
    WHERE e.app=$1 AND e.removed_at IS NULL ORDER BY e.added_at, e.id`, [app])).rows;
  const testers = [];
  for (const enrollment of enrollments) {
    const rows = await checkinsFor(database, enrollment.id);
    const dates = rows.map(row => row.manila_date);
    const progress = testerProgress(enrollment, dates, today);
    const feedback = await feedbackFor(database, enrollment.user_id, app);
    const last = rows.at(-1);
    testers.push({ userId: enrollment.user_id, name: enrollment.name, email: enrollment.email, role: app,
      addedAt: enrollment.added_at, day: progress.day, streak: progress.streak,
      lastCheckInDate: last?.manila_date || null, latestVersion: last?.version || null,
      stoppedCheckingIn: !progress.runComplete && !config.production_approved_at
        && dateDistance(last?.manila_date || manilaDate(enrollment.added_at), today) >= 3,
      days: testerDayBoxes(enrollment, dates, today),
      feedback: { shownCount: feedback.length, tappedAt: feedback.find(row => row.tapped_at)?.tapped_at || null,
        dismissedCount: feedback.filter(row => row.dismissed_at).length } });
  }
  const playOptIn = await playOpsRead(database, app);
  return { app, playOptIn, stats: { activeToday: testers.filter(row => row.lastCheckInDate === today).length,
    fullStreak: testers.filter(row => row.streak >= 14).length, needed: playOptIn.target,
    playClockStartDate: config.play_clock_start_date, optedInCount: config.opted_in_count, productionApprovedAt: config.production_approved_at }, testers };
}

/** All mutations (including audit) share the domain advisory lock; reads use a snapshot. */
export async function routeTesterProgram({ req, url, user, database, readBody, auditEvent, broadcast, now = () => new Date().toISOString() }) {
  if (isPlayOptinRoute(url.pathname)) return routePlayOptin({ req, url, user, database, readBody, auditEvent, broadcast, now });
  const path = url.pathname;
  if (!isTesterProgramRoute(path)) return null;
  if (!user) return fail(401, 'unauthorized');
  const ops = path.startsWith('/ops/');
  if (ops && !['ops_admin', 'super_admin'].some(role => identityHasMembership(user, role))) return fail(403, 'forbidden');
  const methods = path === '/me/tester-program' ? ['GET'] : path.startsWith('/me/') ? ['POST']
    : path === '/ops/testers' ? ['GET', 'POST'] : path === '/ops/testers/settings' ? ['PATCH'] : ['DELETE'];
  if (!methods.includes(req.method)) return fail(404, 'not_found');
  const read = req.method === 'GET';
  const body = read || req.method === 'DELETE' ? {} : await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_request');
  const app = read ? url.searchParams.get('app') : req.method === 'DELETE' ? path.split('/')[3] : body.app;
  if (!APPS.includes(app)) return fail(400, 'invalid_app');
  if (!ops && !identityHasMembership(user, app)) return fail(403, 'forbidden');

  const execute = async () => {
    const at = now(); // Server clock only, read after lock acquisition.
    const today = manilaDate(at);
    if (ops) {
      if (read && path === '/ops/testers') return ok(await opsRead(database, app, at));
      if (req.method === 'POST' && path === '/ops/testers') {
        if (typeof body.email !== 'string' || body.email.length > 320 || /[\x00-\x1f\x7f]/.test(body.email)
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return fail(400, 'invalid_email');
        const targets = (await database.query('SELECT id FROM users WHERE lower(email)=lower($1)', [body.email])).rows;
        if (!targets.length) return fail(404, 'user_not_found');
        if (targets.length !== 1) return fail(409, 'ambiguous_email');
        const target = targets[0];
        if (!(await database.query('SELECT 1 FROM user_role_memberships WHERE user_id=$1 AND role=$2', [target.id, app])).rows.length) return fail(400, 'role_mismatch');
        if (await enrollmentFor(database, target.id, app)) return fail(409, 'already_enrolled');
        const id = randomUUID();
        await database.query('INSERT INTO tester_program_enrollments(id,user_id,app,added_at,added_by) VALUES ($1,$2,$3,$4,$5)', [id, target.id, app, at, user.id]);
        await auditEvent({ actor: user, action: 'tester_program.enrolled', entityType: 'tester_program', entityId: id, detail: { userId: target.id, app } });
        return ok({ ok: true });
      }
      if (req.method === 'DELETE' && /^\/ops\/testers\/[^/]+\/[^/]+$/.test(path)) {
        let userId;
        try { userId = decodeURIComponent(path.split('/')[4]); } catch { return fail(400, 'invalid_user_id'); }
        if (userId.includes('\0')) return fail(400, 'invalid_user_id');
        const enrollment = await enrollmentFor(database, userId, app);
        if (!enrollment) return fail(404, 'not_enrolled');
        await database.query('UPDATE tester_program_enrollments SET removed_at=$2 WHERE id=$1', [enrollment.id, at]);
        await auditEvent({ actor: user, action: 'tester_program.removed', entityType: 'tester_program', entityId: enrollment.id, detail: { userId, app } });
        return ok({ ok: true });
      }
      if (req.method === 'PATCH' && path === '/ops/testers/settings') {
        if (Object.keys(body).some(key => !['app', 'playClockStartDate', 'optedInCount', 'productionApprovedAt', ...PLAY_SETTING_KEYS].includes(key))) return fail(400, 'unexpected_field');
        if (body.playClockStartDate !== undefined && body.playClockStartDate !== null && !validDate(body.playClockStartDate)) return fail(400, 'invalid_play_clock_start_date');
        if (body.optedInCount !== undefined && (!Number.isSafeInteger(body.optedInCount) || body.optedInCount < 0 || body.optedInCount > 2147483647)) return fail(400, 'invalid_opted_in_count');
        if (body.productionApprovedAt !== undefined && body.productionApprovedAt !== null && (!validTimestamp(body.productionApprovedAt) || Date.parse(body.productionApprovedAt) > Date.parse(at))) return fail(400, 'invalid_production_approved_at');
        const playError = validatePlaySettings(body);
        if (playError) return fail(400, playError);
        const previous = await settings(database, app);
        const current = { play_clock_start_date: body.playClockStartDate === undefined ? previous.play_clock_start_date : body.playClockStartDate,
          opted_in_count: body.optedInCount ?? previous.opted_in_count,
          production_approved_at: body.productionApprovedAt === undefined ? previous.production_approved_at : body.productionApprovedAt };
        await database.query(`INSERT INTO tester_program_settings(app,play_clock_start_date,opted_in_count,production_approved_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(app) DO UPDATE SET play_clock_start_date=$2, opted_in_count=$3, production_approved_at=$4`,
        [app, current.play_clock_start_date, current.opted_in_count, current.production_approved_at]);
        await writePlaySettings(database, app, body);
        Object.assign(current, await settings(database, app));
        await auditEvent({ actor: user, action: 'tester_program.settings_updated', entityType: 'tester_program_settings', entityId: app, before: previous, after: current });
        return ok({ ok: true });
      }
      return fail(404, 'not_found');
    }

    const enrollment = await enrollmentFor(database, user.id, app);
    if (!enrollment) return read ? ok({ enrolled: false }) : fail(404, 'not_enrolled');
    const config = await settings(database, app);
    if (read && path === '/me/tester-program') return ok(await ownState(database, enrollment, config, at));
    if (req.method === 'POST' && path === '/me/tester-program/check-in') {
      if (typeof body.version !== 'string' || !body.version.trim() || body.version.length > 100 || /[\x00-\x1f\x7f]/.test(body.version)) return fail(400, 'invalid_version');
      if (!['open', 'button'].includes(body.source)) return fail(400, 'invalid_source');
      if (enrollment.completed_at || config.production_approved_at) return ok(await ownState(database, enrollment, config, at));
      const row = (await database.query(`INSERT INTO tester_program_checkins(id,user_id,app,manila_date,version,source,checked_in_at,latest_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(user_id,app,manila_date) DO UPDATE
        SET latest_seen_at=GREATEST(tester_program_checkins.latest_seen_at,EXCLUDED.latest_seen_at) RETURNING id`,
      [randomUUID(), user.id, app, today, body.version, body.source, at])).rows[0];
      await database.query('INSERT INTO tester_program_enrollment_days(enrollment_id,checkin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [enrollment.id, row.id]);
      const dates = (await checkinsFor(database, enrollment.id)).map(row => row.manila_date);
      if (testerProgress(enrollment, dates, today).streak >= 14) {
        await database.query('UPDATE tester_program_enrollments SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL', [enrollment.id, at]);
        enrollment.completed_at = at;
      }
      return ok(await ownState(database, enrollment, config, at));
    }
    if (req.method === 'POST' && path === '/me/tester-program/feedback') {
      if (!['shown', 'tapped', 'dismissed'].includes(body.event)) return fail(400, 'invalid_event');
      if (!TRIGGERS.includes(body.trigger)) return fail(400, 'invalid_trigger');
      const feedback = await feedbackFor(database, user.id, app);
      if (body.event === 'shown') {
        const state = await ownState(database, enrollment, config, at);
        if (state.nudge?.trigger !== body.trigger) {
          // A lost shown response can be retried while the same prompt is live.
          const latest = feedback[0];
          if (latest?.enrollment_id === enrollment.id && latest.trigger === body.trigger && !latest.tapped_at && !latest.dismissed_at
            && Date.parse(at) - Date.parse(latest.shown_at) < COOLDOWN_MS) return ok({ ok: true });
          return fail(409, 'nudge_not_available');
        }
        const order = body.trigger === 'completed_order' ? await completedOrderFor(database, enrollment, feedback[0], at) : null;
        await database.query('INSERT INTO tester_program_feedback(id,enrollment_id,user_id,app,trigger,shown_at,order_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), enrollment.id, user.id, app, body.trigger, at, order?.id || null]);
      } else {
        const prompt = feedback[0];
        if (!prompt || prompt.enrollment_id !== enrollment.id || prompt.trigger !== body.trigger) return fail(409, 'feedback_not_shown');
        const column = body.event === 'tapped' ? 'tapped_at' : 'dismissed_at';
        await database.query(`UPDATE tester_program_feedback SET ${column}=COALESCE(${column},$2) WHERE id=$1`, [prompt.id, at]);
      }
      return ok({ ok: true });
    }
    return fail(404, 'not_found');
  };
  return read ? database.snapshot(execute) : database.transaction(execute);
}
