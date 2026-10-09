import { randomUUID } from 'node:crypto';
import { authorizationContextFor, contextHasMembership } from './authorization-context.js';

export const LEGAL_SLOTS = [
  ['terms-of-service', 'Terms of Service', 'all'], ['privacy-notice', 'Privacy Notice', 'all'],
  ['supplier-agreement', 'Supplier Agreement', 'supplier'], ['rider-agreement', 'Rider Agreement', 'rider'],
  ['hub-staff-terms', 'Hub Staff Terms', 'staff'], ['cookie-notice', 'Cookie Notice', 'all'],
  ['age-policy', 'Age Policy', 'all'], ['acceptable-use', 'Acceptable Use and Artwork Rights', 'all'],
];
const audiences = ['all', 'client', 'supplier', 'rider', 'staff'];
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const uid = () => randomUUID();
const bounded = (value, max, required = true) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
const rolesFor = user => (authorizationContextFor(user)?.memberships || []).map(m => m.role);
const applies = (v, roles) => v.audience === 'all' || roles.includes(v.audience);
const project = v => ({ id: v.id, documentId: v.document_id, version: v.version, ...v.snapshot,
  audience: v.audience, effectiveAt: v.effective_at, publishedAt: v.published_at,
  placeholder: v.placeholder, material: v.material, penalties: v.penalties,
  status: v.placeholder ? 'placeholder' : 'live', pdfUrl: v.pdf_file_id ? `/legal/versions/${v.id}/pdf` : null });

export async function seedLegalDocuments(database) {
  for (const [id, title, audience] of LEGAL_SLOTS) {
    const draft = { title, audience, text: `Placeholder — ${title}. GRIDGO will publish the reviewed text here. This placeholder is not the final legal document.`,
      pdfFileId: null, placeholder: true, material: false, penalties: false, changeSummary: 'Launch placeholder', effectiveAt: '2026-01-01T00:00:00.000Z' };
    await database.query('INSERT INTO legal_documents(id,draft,launch_slot) VALUES($1,$2,true) ON CONFLICT DO NOTHING RETURNING id', [id, draft]);
    await database.query(`INSERT INTO legal_versions(id,document_id,version,audience,effective_at,placeholder,material,snapshot)
      SELECT $1,$2,1,$3,$4,true,false,$5 WHERE NOT EXISTS(SELECT 1 FROM legal_versions WHERE document_id=$2) ON CONFLICT DO NOTHING`, [`${id}-1`, id, audience, draft.effectiveAt, draft]);
  }
}
export async function currentLegalVersions(database) {
  return (await database.query(`SELECT DISTINCT ON (document_id) * FROM legal_versions
    WHERE effective_at <= now() ORDER BY document_id, version DESC`)).rows;
}
export async function legalRequirements(database, user) {
  const roles = rolesFor(user);
  const versions = (await currentLegalVersions(database)).filter(v => applies(v, roles));
  // A non-material follow-up does not erase an unaccepted material change.
  const history = (await database.query(`SELECT document_id,version FROM legal_versions WHERE effective_at <= now()
    AND material AND NOT placeholder ORDER BY version DESC`)).rows;
  const accepted = (await database.query("SELECT version_id FROM legal_acceptances WHERE user_id=$1 AND purpose IN ('document','enrollment')", [user.id])).rows.map(r => r.version_id);
  const acceptedVersions = (await database.query("SELECT v.document_id,v.version FROM legal_versions v JOIN legal_acceptances a ON a.version_id=v.id WHERE a.user_id=$1 AND a.purpose IN ('document','enrollment')", [user.id])).rows;
  const pending = [], notices = [];
  for (const v of versions) {
    if (accepted.includes(v.id)) continue;
    const previous = Math.max(0, ...acceptedVersions.filter(a => a.document_id === v.document_id).map(a => a.version));
    const missedMaterial = history.some(h => h.document_id === v.document_id && h.version > previous && h.version <= v.version);
    // First-use agreements are required even if a later editorial version is current.
    const agreement = ['terms-of-service','privacy-notice','supplier-agreement','rider-agreement','hub-staff-terms'].includes(v.document_id);
    (missedMaterial || (!previous && agreement) ? pending : notices).push(project(v));
  }
  return { blocking: pending.length > 0, pending, notices };
}
function metadata(body) {
  if (!bounded(body?.app, 80) || !bounded(body?.device, 200) || !['checkbox','blocking_screen'].includes(body?.method)) fail(400, 'invalid_acceptance_metadata');
  return [body.method, body.app.trim(), body.device.trim()];
}
async function validateVersions(database, refs, roles) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 30 || refs.some(r => typeof r !== 'string') || new Set(refs).size !== refs.length) fail(400, 'invalid_legal_versions');
  const current = await currentLegalVersions(database);
  return refs.map(id => {
    const version = current.find(v => v.id === id);
    if (!version) fail(409, 'legal_version_changed');
    if (!applies(version, roles)) fail(403, 'legal_audience_mismatch');
    return version;
  });
}
export async function recordLegalAcceptances(database, user, body, { purpose = 'document', roles = rolesFor(user), orderId = null, versions = null } = {}) {
  const meta = metadata(body);
  if (body.accepted !== true) fail(400, 'legal_consent_required');
  versions ||= await validateVersions(database, body.versionIds, roles);
  const ids = [];
  for (const v of versions) {
    const result = await database.query(`INSERT INTO legal_acceptances(id,user_id,version_id,method,app,device,purpose,order_id,marketing,junior,guardian)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [uid(), user.id, v.id, ...meta, purpose, orderId, purpose === 'enrollment' ? body.marketing === true : null,
      purpose === 'enrollment' ? body.junior : null, purpose === 'enrollment' ? body.guardian === true : null]);
    if (result.rows[0]) ids.push(result.rows[0].id);
  }
  return ids;
}
// v1 is opt-in by new app bodies; never infer consent for legacy callers.
export async function validateEnrollmentConsent(database, body, role) {
  if (body?.legalConsentVersion === undefined && body?.legalConsent === undefined) return null;
  if (body.legalConsentVersion !== 1) fail(400, 'unsupported_legal_consent_version');
  const consent = body.legalConsent;
  metadata(consent);
  if (consent?.accepted !== true || consent.method !== 'checkbox' || typeof consent.junior !== 'boolean'
      || (consent.marketing !== undefined && typeof consent.marketing !== 'boolean')
      || (consent.guardian !== undefined && typeof consent.guardian !== 'boolean')
      || (consent.junior && consent.guardian !== true)) fail(400, 'legal_consent_required');
  const versions = await validateVersions(database, consent.versionIds, [role]);
  const required = ['terms-of-service','privacy-notice', ...(['supplier','rider'].includes(role) ? [`${role}-agreement`] : [])];
  if (required.some(id => !versions.some(v => v.document_id === id))) fail(400, 'legal_consent_required');
  return { consent, versions };
}
export async function recordEnrollmentConsent(database, user, validated) {
  if (validated) await recordLegalAcceptances(database, user, validated.consent, { purpose: 'enrollment', versions: validated.versions });
}
export async function recordArtworkConsent(database, user, order, body) {
  if (body?.legalConsentVersion === undefined && body?.artworkRights === undefined) return;
  if (body.legalConsentVersion !== 1) fail(400, 'unsupported_legal_consent_version');
  const consent = body.artworkRights;
  if (user.id !== order.clientId || user.role !== 'client') fail(403, 'forbidden');
  if (!consent || consent.method !== 'checkbox') fail(400, 'artwork_rights_required');
  const versions = await validateVersions(database, consent.versionIds, ['client']);
  if (versions.length !== 1 || versions[0].document_id !== 'acceptable-use' || consent.accepted !== true) fail(400, 'artwork_rights_required');
  await recordLegalAcceptances(database, user, consent, { purpose: 'artwork', orderId: order.id, versions });
}
export async function loadLegalPenaltyGate(database) {
  const version = (await database.query("SELECT id,version,placeholder,penalties FROM legal_versions WHERE document_id='supplier-agreement' AND effective_at<=now() ORDER BY version DESC LIMIT 1")).rows[0];
  if (!version || version.placeholder) return null;
  const users = version.penalties ? (await database.query(`SELECT DISTINCT a.user_id FROM legal_acceptances a JOIN legal_versions v ON v.id=a.version_id
    WHERE v.document_id='supplier-agreement' AND v.penalties AND v.effective_at<=now() AND v.version <= $1
    AND v.version >= COALESCE((SELECT max(version) FROM legal_versions WHERE document_id='supplier-agreement' AND material AND effective_at<=now()),1)
    AND a.purpose IN ('document','enrollment')`, [version.version])).rows.map(r => r.user_id) : [];
  return { versionId: version.id, acceptedSupplierIds: users };
}
export function legalCsv(rows) {
  const columns = ['id','user_id','document_id','version','version_id','accepted_at','method','app','device','purpose','order_id','marketing','junior','guardian'];
  const cell = value => `"${String(value ?? '').replace(/^[\s]*[=+@-]/, match => `'${match}`).replaceAll('"','""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
function draftInput(input) {
  if (!input || !bounded(input.title, 200) || !audiences.includes(input.audience) || !bounded(input.changeSummary, 4000)
      || typeof input.placeholder !== 'boolean' || typeof input.material !== 'boolean' || typeof input.penalties !== 'boolean'
      || !Number.isFinite(Date.parse(input.effectiveAt)) || (!bounded(input.text, 200000) && !bounded(input.pdfFileId, 200))) fail(400, 'invalid_legal_document');
  if ((input.text != null && !bounded(input.text, 200000, false)) || (input.pdfFileId != null && !bounded(input.pdfFileId, 200))) fail(400, 'invalid_legal_document');
  return { title: input.title, audience: input.audience, text: input.text || '', pdfFileId: input.pdfFileId || null,
    changeSummary: input.changeSummary, placeholder: input.placeholder, material: input.material, penalties: input.penalties,
    effectiveAt: new Date(input.effectiveAt).toISOString() };
}
const privacyProjection = r => ({ id: r.id, userId: r.user_id, kind: r.kind, status: r.status, details: r.details,
  resolution: r.resolution, requestedAt: r.requested_at, dueAt: r.due_at, handlerId: r.handler_id, updatedAt: r.updated_at, revision: r.revision });

export async function routeLegal({ req, url, user, database, readBody, onEvent, signPdf }) {
  const path = url.pathname;
  if (!/^\/(legal|me\/legal|me\/privacy-requests|admin\/legal|admin\/privacy-requests)(\/|$)/.test(path)) return null;
  const bodyObject = async () => {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_legal_body');
    return body;
  };
  const out = (body, status = 200) => ({ status, body });
  if (req.method === 'GET' && path === '/legal/documents') {
    const audience = url.searchParams.get('audience') || 'all';
    if (!audiences.includes(audience)) fail(400, 'invalid_legal_audience');
    return out({ documents: (await currentLegalVersions(database)).filter(v => audience === 'all' || v.audience === 'all' || v.audience === audience).map(project) });
  }
  const publicVersion = /^\/legal\/versions\/([^/]+)(\/pdf)?$/.exec(path);
  if (req.method === 'GET' && publicVersion) {
    const version = (await database.query('SELECT * FROM legal_versions WHERE id=$1 AND effective_at<=now()', [publicVersion[1]])).rows[0];
    if (!version) fail(404, 'not_found');
    if (!publicVersion[2]) return out({ document: project(version) });
    if (!version.pdf_file_id) fail(404, 'not_found');
    return out(await signPdf(version.pdf_file_id));
  }
  if (!user) fail(401, 'unauthorized');
  if (path === '/me/legal/pending' && req.method === 'GET') return out(await legalRequirements(database, user));
  if (path === '/me/legal/accept' && req.method === 'POST') {
    const ids = await recordLegalAcceptances(database, user, await bodyObject());
    if (ids.length) await onEvent({ action: 'legal.accepted', id: user.id, actor: user, detail: { acceptanceIds: ids } });
    return out({ ...(await legalRequirements(database, user)), recorded: ids.length });
  }
  const mine = path === '/me/privacy-requests';
  const admin = path.startsWith('/admin/');
  const context = authorizationContextFor(user);
  const superAdmin = contextHasMembership(context, 'super_admin');
  if (admin && !superAdmin && !contextHasMembership(context, 'ops_admin')) fail(403, 'forbidden');
  if (mine && req.method === 'POST') {
    const body = await bodyObject();
    if (!['access','correction','deletion'].includes(body.kind) || !bounded(body.details ?? '', 4000, false)) fail(400, 'invalid_privacy_request');
    if (body.confirmed !== true) fail(400, 'confirmation_required');
    const row = (await database.query('INSERT INTO privacy_requests(id,user_id,kind,details) VALUES($1,$2,$3,$4) RETURNING *', [uid(), user.id, body.kind, body.details || ''])).rows[0];
    await onEvent({ action: 'privacy.requested', id: row.id, actor: user });
    return out({ request: privacyProjection(row) }, 201);
  }
  if ((mine || path === '/admin/privacy-requests') && req.method === 'GET') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_offset');
    const status = url.searchParams.get('status');
    if (status && !['pending','in_progress','completed','rejected'].includes(status)) fail(400, 'invalid_status');
    const rows = (await database.query('SELECT * FROM privacy_requests WHERE ($1::text IS NULL OR user_id=$1) AND ($2::text IS NULL OR status=$2) ORDER BY due_at,id LIMIT 101 OFFSET $3', [mine ? user.id : null, status, offset])).rows;
    return out({ requests: rows.slice(0,100).map(privacyProjection), nextOffset: rows.length > 100 ? offset + 100 : null });
  }
  const privacyId = /^\/admin\/privacy-requests\/([^/]+)$/.exec(path)?.[1];
  if (privacyId && req.method === 'PATCH') {
    const body = await bodyObject();
    const row = (await database.query('SELECT * FROM privacy_requests WHERE id=$1', [privacyId])).rows[0];
    if (!row) fail(404, 'not_found');
    if (body.expectedRevision !== row.revision) fail(409, 'privacy_request_changed');
    const status = body.status ?? row.status, dueAt = body.dueAt ?? row.due_at, handlerId = Object.hasOwn(body, 'handlerId') ? body.handlerId : row.handler_id;
    if (!['pending','in_progress','completed','rejected'].includes(status) || !Number.isFinite(Date.parse(dueAt)) || !bounded(body.resolution ?? row.resolution, 4000, false)) fail(400, 'invalid_privacy_request');
    if (['completed','rejected'].includes(status) && !bounded(body.resolution ?? row.resolution,4000)) fail(400, 'resolution_required');
    if (handlerId != null && !(await database.query("SELECT 1 FROM user_role_memberships WHERE user_id=$1 AND role IN ('ops_admin','super_admin')", [handlerId])).rows.length) fail(400, 'invalid_privacy_handler');
    const updated = (await database.query('UPDATE privacy_requests SET status=$2,due_at=$3,handler_id=$4,resolution=$5,updated_at=now(),revision=revision+1 WHERE id=$1 RETURNING *', [row.id,status,new Date(dueAt).toISOString(),handlerId,body.resolution ?? row.resolution])).rows[0];
    await onEvent({ action: 'privacy.updated', id: row.id, actor: user, detail: { status, dueAt, handlerId } });
    return out({ request: privacyProjection(updated) });
  }
  if (path === '/admin/legal/acceptances' && req.method === 'GET') {
    const userId = url.searchParams.get('userId');
    if (!bounded(userId,200)) fail(400, 'user_id_required');
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail(400,'invalid_offset');
    const rows = (await database.query(`SELECT a.*,v.document_id,v.version FROM legal_acceptances a JOIN legal_versions v ON v.id=a.version_id
      WHERE user_id=$1 ORDER BY accepted_at,id LIMIT 1001 OFFSET $2`, [userId,offset])).rows;
    const nextOffset = rows.length > 1000 ? offset + 1000 : null;
    if (url.searchParams.get('format') === 'csv') return { status: 200, csv: legalCsv(rows.slice(0,1000)), nextOffset };
    return out({ acceptances: rows.slice(0,1000), nextOffset });
  }
  if (path.startsWith('/admin/legal/documents')) {
    const match = /^\/admin\/legal\/documents(?:\/([^/]+))?(\/publish)?$/.exec(path);
    if (!match) fail(404, 'not_found');
    const documentId = match[1];
    if (req.method === 'GET') {
      const documents = (await database.query('SELECT * FROM legal_documents WHERE ($1::text IS NULL OR id=$1) ORDER BY id', [documentId || null])).rows;
      const versions = (await database.query('SELECT * FROM legal_versions WHERE ($1::text IS NULL OR document_id=$1) ORDER BY document_id,version DESC', [documentId || null])).rows;
      return out({ documents: documents.map(d => ({ id: d.id, revision: d.revision, draft: d.draft, launchSlot: d.launch_slot, versions: versions.filter(v=>v.document_id===d.id).map(project) })) });
    }
    if (!superAdmin) fail(403, 'forbidden');
    const body = await bodyObject();
    if (!documentId && req.method === 'POST') {
      if (!/^[a-z][a-z0-9-]{2,79}$/.test(body.id || '')) fail(400, 'invalid_document_id');
      const draft = draftInput(body.draft);
      if ((await database.query('SELECT 1 FROM legal_documents WHERE id=$1',[body.id])).rows.length) fail(409,'document_exists');
      await database.query('INSERT INTO legal_documents(id,draft) VALUES($1,$2)',[body.id,draft]);
      await onEvent({ action:'legal.created',id:body.id,actor:user,detail:{revision:1} });
      return out({id:body.id,revision:1,draft},201);
    }
    const doc = (await database.query('SELECT * FROM legal_documents WHERE id=$1',[documentId])).rows[0];
    if (!doc) fail(404,'not_found');
    if (body.expectedRevision !== doc.revision) fail(409,'legal_document_changed');
    if (req.method === 'DELETE' && !match[2]) {
      if (doc.launch_slot || (await database.query('SELECT 1 FROM legal_versions WHERE document_id=$1',[doc.id])).rows.length) fail(409,'published_document_retained');
      await database.query('DELETE FROM legal_documents WHERE id=$1',[doc.id]);
      await onEvent({action:'legal.deleted',id:doc.id,actor:user});
      return out({ok:true});
    }
    if (req.method === 'PATCH' && !match[2]) {
      const draft = draftInput({...doc.draft,...body.draft});
      const slot = LEGAL_SLOTS.find(slot => slot[0] === doc.id);
      if (slot && draft.audience !== slot[2]) fail(400,'launch_audience_immutable');
      await database.query('UPDATE legal_documents SET draft=$2,revision=revision+1 WHERE id=$1',[doc.id,draft]);
      await onEvent({action:'legal.edited',id:doc.id,actor:user,detail:{revision:doc.revision+1,draft}});
      return out({id:doc.id,revision:doc.revision+1,draft});
    }
    if (req.method === 'POST' && match[2]) {
      const draft = draftInput(doc.draft);
      const earlier = (await database.query('SELECT * FROM legal_versions WHERE document_id=$1 ORDER BY version DESC',[doc.id])).rows;
      if (earlier.some(v=>!v.placeholder) && draft.placeholder) fail(409,'cannot_restore_placeholder');
      const version = (earlier[0]?.version || 0) + 1;
      if (earlier[0] && Date.parse(draft.effectiveAt) < Date.parse(earlier[0].effective_at)) fail(400,'effective_date_before_previous');
      if (draft.penalties && (doc.id !== 'supplier-agreement' || draft.placeholder)) fail(400,'invalid_penalty_document');
      if (draft.pdfFileId) {
        const file = (await database.query("SELECT 1 FROM files WHERE file_id=$1 AND purpose='legal_document' AND state='ready' AND detected_content_type='application/pdf'",[draft.pdfFileId])).rows[0];
        if (!file) fail(400,'legal_pdf_required');
      }
      // First real text and penalty/audience changes always require fresh consent.
      const material = !draft.placeholder && (draft.material || !earlier.some(v=>!v.placeholder) || earlier[0]?.penalties !== draft.penalties || earlier[0]?.audience !== draft.audience);
      const row = (await database.query(`INSERT INTO legal_versions(id,document_id,version,audience,effective_at,placeholder,material,penalties,snapshot,pdf_file_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[uid(),doc.id,version,draft.audience,draft.effectiveAt,draft.placeholder,material,draft.penalties,draft,draft.pdfFileId])).rows[0];
      await database.query('UPDATE legal_documents SET revision=revision+1 WHERE id=$1',[doc.id]);
      await onEvent({action:'legal.published',id:doc.id,actor:user,detail:{versionId:row.id,version,material}});
      return out({document:project(row),revision:doc.revision+1},201);
    }
  }
  fail(404,'not_found');
}
