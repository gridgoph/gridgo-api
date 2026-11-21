import { actorUserId } from './shop-team.js';
import { canReadOrderArtwork } from './order-file-access.js';
import { artworkFileIdsFor } from './artwork-attachments.js';
import { queueOrderInvalidate } from './notifications.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const fields = { job_id:'jobId', order_id:'orderId', shop_id:'shopId', user_id:'userId', device_id:'deviceId', file_id:'fileId', action:'action', first_at:'firstAt', last_at:'lastAt', access_count:'count' };
export const fileAccessTable = { name:'shop_file_accesses', keys:['job_id','shop_id','user_id','device_id','file_id','action'], columns:Object.keys(fields) };
export const fileAccessRows = store => (store.shopFileAccesses || []).map(row => Object.fromEntries(Object.entries(fields).map(([sql,js])=>[sql,row[js]])));
export const loadFileAccessRows = rows => rows.map(row => Object.fromEntries(Object.entries(fields).map(([sql,js])=>[js,row[sql]])));

export function fileAccessJobs(store, user, order, file) {
  if (user?.role !== 'supplier' || !['artwork','mockup'].includes(file?.purpose)
    || !canReadOrderArtwork(user,store,order,file.fileId,file.purpose,file)) return [];
  const linked = file.references?.some(ref=>ref.type==='order'&&ref.id===order.id)
    || store.orderLineItems?.some(line=>line.orderId===order.id&&(file.purpose==='artwork'?artworkFileIdsFor(line).includes(file.fileId):line.mockupFileId===file.fileId));
  if (!linked) return [];
  return (store.orderJobs || []).filter(job => job.orderId===order.id && job.supplierId===user.id && job.state!=='cancelled'
    && ((store.orderLineItems || []).some(line => line.jobId===job.id && (file.purpose==='artwork' ? artworkFileIdsFor(line).includes(file.fileId) : line.mockupFileId===file.fileId))
      || (store.orderJobs || []).filter(candidate=>candidate.orderId===order.id).length===1));
}
export function recordShopFileAccess(store, user, order, file, { jobId, action, deviceId = 'unspecified', at }) {
  if (!['opened','downloaded','download_authorized'].includes(action)
    || typeof deviceId!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceId)) fail(400,'invalid_file_access');
  const jobs=fileAccessJobs(store,user,order,file).filter(job=>!jobId||job.id===jobId);
  if(!jobs.length)fail(403,'forbidden');
  const rows=(store.shopFileAccesses ||= []),userId=actorUserId(user);
  for(const job of jobs) {
    let row=rows.find(row=>row.jobId===job.id&&row.shopId===user.id&&row.userId===userId&&row.deviceId===deviceId&&row.fileId===file.fileId&&row.action===action);
    if(row) { row.lastAt=at;row.count=Math.min(2147483647,row.count+1); }
    else { row={jobId:job.id,orderId:order.id,shopId:user.id,userId,deviceId,fileId:file.fileId,action,firstAt:at,lastAt:at,count:1};rows.push(row); }
  }
  queueOrderInvalidate(store,order,['jobs','orders']);
}
export function publicShopFileAccesses(store, order, user) {
  if(user?.role!=='supplier')return undefined;
  return (store?.shopFileAccesses || []).filter(row=>row.orderId===order.id&&row.shopId===user.id)
    .map(({jobId,userId,deviceId,fileId,action,firstAt,lastAt,count})=>({jobId,userId,deviceId,fileId,action,firstAt,lastAt,count}));
}
export async function routeShopFileAccess({ req,url,store,user,readBody,now,audit,authorizeFileRead }) {
  const match=/^\/orders\/([^/]+)\/files\/([^/]+)\/access$/.exec(url.pathname);
  if(!match||req.method!=='POST')return null;
  if(user?.role!=='supplier')fail(403,'forbidden');
  const order=store.orders.find(order=>order.id===match[1]),file=store.files.find(file=>file.fileId===match[2]);
  if(!order||!file)fail(404,'file_not_found');
  authorizeFileRead(user,store,file);
  const body=await readBody(req);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['action','deviceId','jobId'].includes(key))
    || !['opened','downloaded'].includes(body.action)||typeof body.deviceId!=='string'||(body.jobId!==undefined&&typeof body.jobId!=='string'))fail(400,'invalid_file_access');
  recordShopFileAccess(store,user,order,file,{...body,at:now()});
  audit(store,{actor:user,action:'order.file_access',entityType:'file',entityId:file.fileId,orderId:order.id,detail:{...(body.jobId?{jobId:body.jobId}:{}),action:body.action}});
  return {status:200,mutated:true,body:{fileAccesses:publicShopFileAccesses(store,order,user)}};
}
