import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { shopLeaderboard } from './shop-leaderboard.js';
import { previousLeaderboardMonth } from './shop-leaderboard-months.js';
import { appendAudit } from './audit.js';
import { isShopStaff } from './shop-team.js';

const fail = (code,status) => { throw Object.assign(new Error(code),{code,status}); };
const validMonth = month => typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

export async function routeShopLeaderboard({req,url,store,user,now,id,readBody}) {
  const path=url.pathname;
  if (req.method==='GET' && path==='/me/shop-leaderboard') {
    if (user?.role!=='supplier') fail('forbidden',403);
    if (isShopStaff(user)) fail('shop_owner_required',403);
    return { status:200,body:shopLeaderboard(store,user.id,url.searchParams.get('period') || 'week',now()) };
  }
  const delivery=/^\/ops\/top-shop-stickers\/([^/]+)\/([^/]+)\/deliver$/.exec(path);
  if (!(req.method==='GET' && path==='/ops/top-shop-stickers') && !(req.method==='POST' && delivery)) return null;
  if (!['ops_admin','super_admin'].includes(user?.role)) fail('forbidden',403);
  const month=delivery?.[1] || url.searchParams.get('month') || previousLeaderboardMonth(now()).month;
  if (!validMonth(month)) fail('invalid_leaderboard_month',400);
  const result=(store.shopLeaderboardMonths || []).find(row=>row.month===month);
  if (delivery) {
    const task=(store.shopTopStickers || []).find(row=>row.month===month && row.supplierId===delivery[2]);
    if (!task) fail('top_shop_sticker_not_found',404);
    const body=await readBody(req);
    if (typeof body?.reason!=='string' || !body.reason.trim() || body.reason.trim().length>2000) fail('reason_required',400);
    if (task.deliveredAt) return {status:200,body:{ok:true},mutated:false};
    task.deliveredAt=now();task.deliveredBy=user.actorUserId || user.id;
    appendAudit(store,{actor:user,action:'shop_leaderboard.sticker_delivered',entityType:'shop_top_sticker',entityId:`${month}:${task.supplierId}`,
      reason:body.reason.trim(),detail:{month,supplierId:task.supplierId}},{at:now(),id});
    const admins=privilegedAdminMemberships(store);
    for(const recipient of admins)(store.notifications ||= []).push({id:id('ntf'),at:now(),userId:recipient.userId,appRole:recipient.role,
      type:'shop_top_sticker_delivered',title:'Top Shop sticker delivered',body:`A Top Shop sticker for ${month} has been delivered.`,read:false});
    queueInvalidate(store,{resource:'notifications',userIds:admins.map(row=>row.userId)});
    return {status:200,body:{ok:true},mutated:true};
  }
  return {status:200,body:{month,closedAt:result?.closedAt ?? null,stickers:(result?.winners || []).map(winner=>{
    const task=(store.shopTopStickers || []).find(row=>row.month===month && row.supplierId===winner.supplierId);
    return {supplierId:winner.supplierId,name:winner.name,printerType:winner.printerType,month,
      status:task?.deliveredAt?'delivered':'pending',deliveredAt:task?.deliveredAt || null,deliveredBy:task?.deliveredBy || null};
  })}};
}
