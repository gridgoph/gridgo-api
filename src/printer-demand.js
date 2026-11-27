import {expressPoint,expressShopList} from './express-orders.js';
import {distanceMetersBetween} from './operational-model.js';
import {queueInvalidate} from './notifications.js';
import {notifyAdmins} from './domain-events.js';
import {manilaDay} from './shop-availability.js';
import {shopMoneySettings} from './shop-money-settings.js';

/** Authenticated demand only; callers hold the transaction-scoped domain lock.
 * Looking is not a job reservation or a promise of priority when a shop opens. */
export function pingPrinterDemand(store,user,body,{at,id}) {
  const location=expressPoint(body?.location),rules=shopMoneySettings(store.settings),day=manilaDay(at);
  // Closed/offline shops may hear demand without changing any actual eligibility.
  const targetStore={...store,supplierProfiles:(store.supplierProfiles||[]).map(p=>({...p,isClosed:true,
    availability:{...p.availability,pausedUntil:null,missedJobPause:null,openRestoreClosed:false},
    ...(p.homePrinter?{homePrinter:{...p.homePrinter,online:true}}:{})}))};
  const shops=expressShopList(targetStore,user,{location,fulfillmentMode:body.fulfillmentMode||'pickup',includeClosed:true},at);
  let changed=false;
  for(const shop of shops) {
    const profile=store.supplierProfiles.find(p=>p.userId===shop.supplierId);
    if(!profile?.shop||profile.availability?.printerDemandPings===false||distanceMetersBetween(location,profile.shop)>rules.demandRadiusMeters)continue;
    const history=(profile.availability?.demandPings||[]).filter(p=>manilaDay(p.at)===day);
    if(history.length>=rules.demandAlertsPerDay||history.some(p=>p.clientId===user.id))continue;
    history.push({day,night:day,clientId:user.id,at});
    profile.availability={...profile.availability,demandPings:history};
    const occurrenceKey=`printer-demand:${profile.userId}:${day}:${history.length}`;
    const members=(store.shopMemberships||[]).filter(m=>m.shopId===profile.userId);
    const recipients=members.length?members.filter(m=>m.status==='active'&&m.role==='owner').map(m=>m.userId):[profile.userId];
    const expiresAt=new Date(Date.parse(`${day}T00:00:00+08:00`)+86400000).toISOString();
    for(const userId of recipients)(store.notifications||=[]).push({id:id('ntf'),userId,appRole:'supplier',shopId:profile.userId,
      type:'printer_demand',title:profile.isClosed?'Jobs waiting while you are closed':'A nearby client needs prints',
      body:'A client nearby is looking for printing. Open Jobs to choose your availability.',at,read:false,occurrenceKey,
      demandVersion:2,night:day,expiresAt});
    notifyAdmins(store,'ops_printer_demand','Nearby printing demand',null,occurrenceKey,{createId:id,at});
    queueInvalidate(store,{resource:'notifications',userIds:recipients});changed=true;
  }
  return changed;
}
