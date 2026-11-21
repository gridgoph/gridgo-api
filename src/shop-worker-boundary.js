import { createHash } from 'node:crypto';
import { assertActiveShop, identityShopRoute, staffRouteAllowed } from './shop-team.js';
import { bindShopDeviceRequest, managerRouteAllowed, resolveShopWorker } from './shop-team-work.js';

const fail = code => { throw Object.assign(new Error(code), {status:403,code}); };
const pickerRoute = (method,path) => (method==='GET' && path==='/me/shop-team/working')
  || (method==='POST' && ['/me/shop-team/working/select','/me/shop-team/working/lock'].includes(path));

/** This policy applies before dispatch, including handlers outside the domain graph. */
export function pinWorkerRouteAllowed(method,path,role) {
  if (pickerRoute(method,path) || (method==='POST' && path==='/auth/logout')) return true;
  // Account transport and shop selection belong to the signed-in carrier.
  if (identityShopRoute(path) || path.startsWith('/me/shop-memberships')) return false;
  return staffRouteAllowed(method,path) || (role==='manager' && managerRouteAllowed(method,path));
}

export async function enforceShopWorkerBoundary(database,req,claims,at) {
  const sid=claims?.sid;
  if (!claims?.sub) return; // An opaque worker token never authenticates an anonymous request.
  if (typeof sid!=='string' || !sid) {
    if (req.headers['x-gridgo-worker-token']) fail('shop_device_session_required');
    return;
  }
  const sessionHash=createHash('sha256').update(sid).digest('hex');
  const {rows:[row]}=await database.query(`SELECT
    s.shop_id AS "shopId",s.user_id AS "userId",s.session_hash AS "sessionHash",
    s.pin_staff_id AS "pinStaffId",s.pin_version AS "pinVersion",s.token_hash AS "tokenHash",s.expires_at AS "expiresAt",
    p.name AS "pinName",p.role AS "pinRole",p.status AS "pinStatus",p.pin_version AS "currentPinVersion",
    m.status AS "membershipStatus",u.account_status AS "accountStatus",shop.account_status AS "shopAccountStatus"
    FROM users u JOIN shop_worker_sessions s ON s.user_id=u.id
    LEFT JOIN shop_pin_staff p ON p.id=s.pin_staff_id AND p.shop_id=s.shop_id
    LEFT JOIN shop_memberships m ON m.shop_id=s.shop_id AND m.user_id=s.user_id
    LEFT JOIN users shop ON shop.id=s.shop_id
    WHERE u.clerk_user_id=$1 AND s.session_hash=$2 AND s.expires_at IS NOT NULL
    ORDER BY s.updated_at DESC LIMIT 1`,[claims.sub,sessionHash]);
  if (!row) {
    if (req.headers['x-gridgo-worker-token']) fail('shop_worker_invalid');
    return;
  }
  // A non-null deadline is a persistent device lock, even after expiry/reset/removal.
  const store={shopWorkerSessions:[row],shopPinStaff:[{
    id:row.pinStaffId,shopId:row.shopId,name:row.pinName,role:row.pinRole,status:row.pinStatus,pinVersion:row.currentPinVersion,
  }]};
  const user={id:row.userId};
  bindShopDeviceRequest(store,req,user);
  const path=new URL(req.url,'http://localhost').pathname;
  if (!pinWorkerRouteAllowed(req.method,path,row.pinRole)) fail('shop_owner_required');
  if ((req.method==='POST' && path==='/auth/logout') || pickerRoute(req.method,path)) return;
  assertActiveShop({status:row.membershipStatus});
  if (row.accountStatus!=='active') fail('forbidden');
  if (row.shopAccountStatus!=='active') fail('shop_unavailable');
  resolveShopWorker(store,req,user,{shopId:row.shopId},at);
}
