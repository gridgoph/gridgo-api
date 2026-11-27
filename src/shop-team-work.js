import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { queueInvalidate } from './notifications.js';
import { teamStats } from './shop-team-stats.js';
const scrypt = promisify(scryptCallback);
const fail = (status,code) => { throw Object.assign(new Error(code),{status,code}); };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = body => body && typeof body === 'object' && !Array.isArray(body);
export function memberPreferences(store, shopId, userId, create=false) {
  store.shopTeamMemberSettings ||= [];
  let row = store.shopTeamMemberSettings.find(s=>s.shopId===shopId && s.userId===userId);
  if (!row && create) { row={shopId,userId,manager:false,jobAlerts:true};store.shopTeamMemberSettings.push(row); }
  return row;
}
export const effectiveShopRole = (store, member) => member.role === 'owner' ? 'owner'
  : memberPreferences(store,member.shopId,member.userId)?.manager ? 'manager' : 'staff';
export function managerRouteAllowed(method,path) {
  if(method==='POST'&&path==='/me/supplier-signup/setup-help')return true;
  if(method==='GET'&&['/me/supplier-signup','/me/payout-status'].includes(path))return true;
  if (['GET','PATCH'].includes(method) && path === '/me/shop-hours') return true;
  if (method === 'GET' && ['/listing-starters','/me/supplier-readiness','/me/supplier-services'].includes(path)) return true;
  if (['GET','POST'].includes(method) && path === '/me/catalog-items') return true;
  if (['GET','PATCH','DELETE'].includes(method) && /^\/me\/catalog-items\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && path === '/me/catalog-items/production-time') return true;
  if (method === 'GET' && /^\/me\/catalog-items\/[^/]+\/production-time-preview$/.test(path)) return true;
  if (method === 'PUT' && /^\/me\/catalog-items\/[^/]+\/file-formats$/.test(path)) return true;
  if (method === 'POST' && /^\/me\/catalog-items\/[^/]+\/(photos|prep-steps)\/reorder$/.test(path)) return true;
  if (['GET','POST'].includes(method) && /^\/me\/catalog-items\/[^/]+\/prep-steps$/.test(path)) return true;
  if (['PATCH','DELETE'].includes(method) && /^\/me\/catalog-items\/[^/]+\/(prep-steps|option-groups)\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && /^\/me\/catalog-items\/[^/]+\/option-groups$/.test(path)) return true;
  if (method === 'POST' && /^\/me\/catalog-option-groups\/[^/]+\/options$/.test(path)) return true;
  if (['PATCH','DELETE'].includes(method) && /^\/me\/catalog-option-groups\/[^/]+\/options\/[^/]+$/.test(path)) return true;
  if (method === 'GET' && path === '/me/shop-team') return true;
  if (method === 'POST' && /^\/me\/shop-team\/(invites|pin-staff)$/.test(path)) return true;
  if (['PATCH','DELETE'].includes(method) && /^\/me\/shop-team\/(members|pin-staff)\/[^/]+$/.test(path)) return true;
  if (method === 'DELETE' && /^\/me\/shop-team\/invites\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && /^\/me\/shop-team\/(invites\/[^/]+\/replace|pin-staff\/[^/]+\/reset)$/.test(path)) return true;
  return false;
}
function sessionFor(store, req, identity, member, create=false, at) {
  const sid = req.gridgoVerifiedClaims?.claims?.sid;
  if (!sid || typeof sid !== 'string') {
    if (create || req.headers['x-gridgo-worker-token']) fail(403,'shop_device_session_required');
    return null;
  }
  store.shopWorkerSessions ||= [];
  const sessionHash=hash(sid);
  let row=store.shopWorkerSessions.find(s=>s.shopId===member.shopId && s.userId===identity.id && s.sessionHash===sessionHash);
  if (!row && create) {row={shopId:member.shopId,userId:identity.id,sessionHash,failedAttempts:0,updatedAt:at};store.shopWorkerSessions.push(row);}
  return row;
}
/** A shared session cannot select the carrier's unrelated platform privileges. */
export function bindShopDeviceRequest(store,req,user) {
  const sid=req.gridgoVerifiedClaims?.claims?.sid;
  if (!sid) return;
  const bound=(store.shopWorkerSessions || []).find(s=>s.userId===user.id && s.sessionHash===hash(sid) && s.expiresAt);
  if (!bound) return;
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  const inboxRole=['/notifications','/notifications/stream','/notifications/read-all'].includes(path)?url.searchParams.get('role'):null;
  if (path==='/auth/logout') return;
  if ((inboxRole && inboxRole!=='supplier') || (req.headers['x-gridgo-role'] && req.headers['x-gridgo-role']!=='supplier')
    || (req.headers['x-gridgo-shop-id'] && req.headers['x-gridgo-shop-id']!==bound.shopId)
    || (/^\/auth\/me\//.test(path) && path!=='/auth/me/supplier')) fail(403,'shop_worker_invalid');
  req.headers['x-gridgo-role']='supplier';
  req.headers['x-gridgo-shop-id']=bound.shopId;
}

/** A selected/locked device must never silently regain its carrier's privileges. */
export function resolveShopWorker(store,req,identity,member,at=new Date().toISOString()) {
  const row=sessionFor(store,req,identity,member);
  const token=req.headers['x-gridgo-worker-token'];
  const sid=req.gridgoVerifiedClaims?.claims?.sid;
  if (sid && (store.shopWorkerSessions || []).some(s=>s.userId===identity.id && s.sessionHash===hash(sid) && s.shopId!==member.shopId && s.expiresAt)) fail(403,'shop_worker_invalid');
  if (!row) {
    const sid=req.gridgoVerifiedClaims?.claims?.sid;
    if(token || (sid && (store.shopWorkerSessions || []).some(s=>s.userId===identity.id && s.sessionHash===hash(sid) && s.expiresAt))) fail(403,'shop_worker_invalid');
    return null;
  }
  // Failed attempts alone do not lock the carrier out; successful selection does.
  if (!row.expiresAt) {if(token) fail(403,'shop_worker_invalid');return null;}
  const person=(store.shopPinStaff || []).find(p=>p.id===row.pinStaffId && p.shopId===member.shopId);
  if (!person || person.status!=='active' || person.pinVersion!==row.pinVersion || Date.parse(row.expiresAt)<=Date.parse(at)
    || typeof token!=='string' || hash(token)!==row.tokenHash) fail(403,'shop_worker_locked');
  return {pinStaffId:person.id,name:person.name,role:person.role};
}
export function publicPinStaff(person) {
  return {id:person.id,pinStaffId:person.id,shopId:person.shopId,kind:'pin',name:person.name,role:person.role,status:person.status,
    jobAlerts:person.jobAlerts,photoFileId:person.photoFileId || null,createdAt:person.createdAt,updatedAt:person.updatedAt};
}
async function pinHash(pin) {
  if (typeof pin!=='string' || !/^\d{4}$/.test(pin)) fail(400,'invalid_shop_pin');
  const salt=randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(pin,salt,32)).toString('hex')}`;
}
async function matchesPin(pin,encoded) {
  if (typeof pin!=='string' || !/^\d{4}$/.test(pin)) return false;
  const [salt,key]=encoded.split(':');
  const actual=await scrypt(pin,salt,32);const expected=Buffer.from(key,'hex');
  return expected.length===actual.length && timingSafeEqual(expected,actual);
}
function photoFor(store, fileId, shopId, identityId) {
  if (fileId === null) return null;
  const file=(store.files || []).find(f=>f.fileId===fileId);
  if (!file || file.purpose!=='shop_team_photo' || file.state!=='ready' || file.ownerId!==shopId
    || file.createdByUserId!==identityId || file.references?.length || !file.detectedContentType?.startsWith('image/')) fail(400,'invalid_shop_team_photo');
  return file.fileId;
}
export function bindTeamPhoto(store,fileId,shopId,memberId) {
  const file=(store.files || []).find(f=>f.fileId===fileId);
  if (file) file.references=[{type:'shop_team_member',shopId,id:memberId,field:'photo'}];
}
export function teamPhotoReadable(store,file,user,shopId) {
  return file?.purpose==='shop_team_photo' && file.ownerId===shopId && (
    (file.createdByUserId===(user.actorUserId || user.id) && !file.references?.length)
    || file.references?.some(r=>r.type==='shop_team_member' && r.shopId===shopId));
}
export async function routeTeamWork({req,url,store,user,member,readBody,id,now,audit,publicMember}) {
  const path=url.pathname, at=now(), shopId=member.shopId;
  const ownRole=effectiveShopRole(store,member);
  const working=/^\/me\/shop-team\/working(?:\/(select|lock))?$/.exec(path);
  const pin=/^\/me\/shop-team\/pin-staff(?:\/([^/]+)(?:\/(reset))?)?$/.exec(path);
  const self=path==='/me/shop-team/me';
  const read = req.method==='GET' && ['/me/shop-team','/me/shop-team/stats','/me/shop-team/settings'].includes(path);
  if (!working && !pin && !self && !read && path!=='/me/shop-team/settings') return null;
  let actor=null;
  if (!working) actor=resolveShopWorker(store,req,user,member,at);
  else if (req.method==='GET') { try { actor=resolveShopWorker(store,req,user,member,at); } catch(error) { if(!['shop_worker_locked','shop_worker_invalid'].includes(error.code))throw error; } }
  const role=actor?.role || ownRole;
  const canManage=['owner','manager'].includes(role);
  const settings=(store.shopTeamSettings ||= []).find(s=>s.shopId===shopId);
  const invalidate=()=>queueInvalidate(store,{resource:'identity',userIds:[shopId,...store.shopMemberships.filter(m=>m.shopId===shopId).map(m=>m.userId)]});
  const event=(action,entityId)=>{audit(store,{actor:user,action:`shop_team.${action}`,entityType:'shop_team',entityId,detail:{shopId}});invalidate();};
  if (working && req.method==='GET' && !working[1]) {
    return {status:200,body:{members:[...store.shopMemberships.filter(m=>m.shopId===shopId && m.status==='active').map(m=>publicMember(store,m)),
      ...(store.shopPinStaff || []).filter(p=>p.shopId===shopId && p.status==='active').map(publicPinStaff)],worker:actor || null}};
  }
  if (working && req.method==='POST' && ['select','lock'].includes(working[1])) {
    const session=sessionFor(store,req,user,member,true,at);
    if ((store.shopWorkerSessions || []).some(s=>s.userId===user.id && s.sessionHash===session.sessionHash && s.shopId!==shopId && s.expiresAt)) fail(403,'shop_worker_invalid');
    if (working[1]==='lock') {
      session.pinStaffId=null;session.tokenHash=null;session.expiresAt=at;session.updatedAt=at;
      event('device_locked',shopId);return {status:200,mutated:true,body:{locked:true}};
    }
    const body=await readBody(req);
    if (!object(body) || Object.keys(body).some(k=>!['pinStaffId','pin'].includes(k))) fail(400,'invalid_shop_worker_selection');
    const person=(store.shopPinStaff || []).find(p=>p.id===body.pinStaffId && p.shopId===shopId && p.status==='active');
    if ([session,person].some(r=>r?.blockedUntil && Date.parse(r.blockedUntil)>Date.parse(at))) return {status:429,mutated:true,body:{error:'shop_pin_rate_limited'}};
    if (!person || !await matchesPin(body.pin,person.pinHash)) {
      for (const row of [session,person].filter(Boolean)) {
        row.failedAttempts=(row.failedAttempts || 0)+1;
        if(row.failedAttempts>=5){row.blockedUntil=new Date(Date.parse(at)+15*60000).toISOString();row.failedAttempts=0;}
      }
      session.updatedAt=at;event('pin_refused',person?.id || shopId);
      return {status:403,mutated:true,body:{error:'shop_pin_invalid'}};
    }
    const token=randomBytes(32).toString('base64url');
    Object.assign(session,{pinStaffId:person.id,pinVersion:person.pinVersion,tokenHash:hash(token),expiresAt:new Date(Date.parse(at)+30*60000).toISOString(),updatedAt:at,failedAttempts:0,blockedUntil:null});
    person.failedAttempts=0;person.blockedUntil=null;event('worker_selected',person.id);
    return {status:200,mutated:true,body:{worker:publicPinStaff(person),token,expiresAt:session.expiresAt}};
  }
  if (path==='/me/shop-team/stats' && req.method==='GET') return {status:200,body:teamStats(store,shopId,role,at)};
  if (path==='/me/shop-team' && req.method==='GET') {
    const sessions=(store.shopWorkerSessions || []).filter(s=>s.shopId===shopId && s.tokenHash && Date.parse(s.expiresAt)>Date.parse(at));
    return {status:200,body:{shop:{id:shopId,name:store.supplierProfiles?.find(p=>p.userId===shopId)?.shopName || 'Print shop'},
      members:store.shopMemberships.filter(m=>m.shopId===shopId && (canManage || m.status==='active')).map(m=>({...publicMember(store,m),kind:'account'})),
      pinStaff:(store.shopPinStaff || []).filter(p=>p.shopId===shopId && (canManage || p.status==='active')).map(p=>({...publicPinStaff(p),onShift:sessions.some(s=>s.pinStaffId===p.id && s.pinVersion===p.pinVersion && p.status==='active')})),
      stats:teamStats(store,shopId,role,at),settings:{jobsHandledBy:settings?.jobsHandledBy || 'just_me',showRankingToStaff:settings?.showRankingToStaff!==false}}};
  }
  if (path==='/me/shop-team/settings') {
    if (req.method==='GET') return {status:200,body:{settings:{jobsHandledBy:settings?.jobsHandledBy || 'just_me',showRankingToStaff:settings?.showRankingToStaff!==false}}};
    if (req.method!=='PATCH') fail(405,'method_not_allowed');
    if(role!=='owner') fail(403,'shop_owner_required');
    const body=await readBody(req);
    if(!object(body) || !Object.keys(body).length || Object.keys(body).some(k=>!['jobsHandledBy','showRankingToStaff'].includes(k))
      || (body.jobsHandledBy!==undefined && !['just_me','me_and_staff'].includes(body.jobsHandledBy))
      || (body.showRankingToStaff!==undefined && typeof body.showRankingToStaff!=='boolean')) fail(400,'invalid_shop_team_settings');
    const row=settings || {shopId};if(!settings)store.shopTeamSettings.push(row);
    Object.assign(row,body,{updatedAt:at});event('settings_updated',shopId);
    return {status:200,mutated:true,body:{settings:{jobsHandledBy:row.jobsHandledBy || 'just_me',showRankingToStaff:row.showRankingToStaff!==false}}};
  }
  if (self && req.method==='PATCH') {
    const body=await readBody(req);
    if(!object(body)||!Object.keys(body).length||Object.keys(body).some(k=>!['jobAlerts','photoFileId'].includes(k)) || (body.jobAlerts!==undefined && typeof body.jobAlerts!=='boolean')) fail(400,'invalid_shop_member_update');
    const target=actor?(store.shopPinStaff || []).find(p=>p.id===actor.pinStaffId):memberPreferences(store,shopId,user.id,true);
    if(Object.hasOwn(body,'photoFileId')) {target.photoFileId=photoFor(store,body.photoFileId,shopId,user.id);bindTeamPhoto(store,target.photoFileId,shopId,actor?.pinStaffId || user.id);}
    if(Object.hasOwn(body,'jobAlerts')) target.jobAlerts=body.jobAlerts;
    event('preferences_updated',actor?.pinStaffId || user.id);
    return {status:200,mutated:true,body:{member:actor?publicPinStaff(target):publicMember(store,member)}};
  }
  if (!pin) fail(405,'method_not_allowed');
  if(!canManage) fail(403,'shop_owner_required');
  store.shopPinStaff ||= [];
  const target=pin[1]?store.shopPinStaff.find(p=>p.id===pin[1] && p.shopId===shopId):null;
  if(pin[1] && !target) fail(404,'shop_member_not_found');
  if(role==='manager' && target?.role==='manager') fail(403,'shop_owner_required');
  if(req.method==='POST' && !pin[1]) {
    const body=await readBody(req);
    if(!object(body)||Object.keys(body).some(k=>!['name','pin','role','photoFileId','jobAlerts'].includes(k))|| typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>100
      || (body.role!==undefined && body.role!=='staff') || (body.jobAlerts!==undefined && typeof body.jobAlerts!=='boolean')) fail(400,'invalid_shop_member_update');
    const person={id:id('shp'),shopId,name:body.name.trim(),role:body.role || 'staff',status:'active',pinHash:await pinHash(body.pin),pinVersion:1,failedAttempts:0,jobAlerts:body.jobAlerts!==false,createdAt:at,updatedAt:at};
    if(body.photoFileId) person.photoFileId=photoFor(store,body.photoFileId,shopId,user.id);
    store.shopPinStaff.push(person);bindTeamPhoto(store,person.photoFileId,shopId,person.id);event('pin_staff_created',person.id);
    return {status:201,mutated:true,body:{member:publicPinStaff(person)}};
  }
  if(!target) fail(405,'method_not_allowed');
  if(target.status==='removed') fail(409,'shop_invite_required');
  if(pin[2]==='reset' && req.method==='POST') {
    const body=await readBody(req);if(!object(body)||Object.keys(body).some(k=>k!=='pin'))fail(400,'invalid_shop_pin');
    target.pinHash=await pinHash(body.pin);target.pinVersion++;target.failedAttempts=0;target.blockedUntil=null;
  } else if(req.method==='DELETE' && !pin[2]) {target.status='removed';target.pinVersion++;}
  else if(req.method==='PATCH' && !pin[2]) {
    const body=await readBody(req);
    if(!object(body)||!Object.keys(body).length||Object.keys(body).some(k=>!['name','role','jobAlerts','photoFileId'].includes(k))
      || (body.name!==undefined && (typeof body.name!=='string'||!body.name.trim()||body.name.length>100))
      || (body.role!==undefined && body.role!=='staff') || (body.jobAlerts!==undefined && typeof body.jobAlerts!=='boolean')) fail(400,'invalid_shop_member_update');
    if(body.role && body.role!==target.role)target.pinVersion++;
    if(Object.hasOwn(body,'photoFileId')){target.photoFileId=photoFor(store,body.photoFileId,shopId,user.id);bindTeamPhoto(store,target.photoFileId,shopId,target.id);}
    for(const key of ['name','role','jobAlerts'])if(Object.hasOwn(body,key))target[key]=key==='name'?body[key].trim():body[key];
  } else fail(405,'method_not_allowed');
  target.updatedAt=at;event(pin[2]==='reset'?'pin_reset':'pin_staff_updated',target.id);
  return {status:200,mutated:true,body:{member:publicPinStaff(target)}};
}
