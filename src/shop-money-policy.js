import {shopMoneySettings} from './shop-money-settings.js';
export const shopMoneyPolicy=(store,supplierId)=>(store.shopMoneyEvents||[]).filter(e=>e.kind==='policy'&&e.supplierId===supplierId).at(-1)?.data||{counterCashEnabled:false,version:0};
export const payRequestClosed=(store,id)=>(store.shopMoneyEvents||[]).some(e=>['pay_confirmed','pay_offset'].includes(e.kind)&&e.data.requestId===id);
export const activeShopTransferForKey=(store,key)=>(store.shopMoneyEvents||[]).find(e=>e.kind==='transfer_reserved'&&e.data.items.some(i=>i.key===key)
  &&!(store.shopMoneyEvents||[]).some(x=>['transfer_paid','transfer_cancelled'].includes(x.kind)&&x.data.transferId===e.id));
export function shopMoneyPaused(store,supplierId,at=new Date().toISOString()) {
  if(store.shopMoneyDeadlines?.has(supplierId)) {
    const deadline=store.shopMoneyDeadlines.get(supplierId);
    return Boolean(deadline&&Date.parse(deadline)<=Date.parse(at));
  }
  return (store.shopMoneyEvents||[]).some(e=>e.kind==='pay_request'&&e.supplierId===supplierId&&e.data.amountMinor>0
    &&(!e.data.weekly||shopMoneySettings(store.settings).overduePauseEnabled)
    &&(e.data.weekly?Date.parse(e.data.deadlineAt)<Date.parse(at):Date.parse(e.data.deadlineAt)<=Date.parse(at))&&!payRequestClosed(store,e.id));
}
/** Bounded facts join the existing profile query instead of every identity read. */
export const shopMoneyDeadlineSql=`SELECT min((r.data->>'deadlineAt')::timestamptz + CASE WHEN r.data->>'weekly'='true' THEN interval '1 millisecond' ELSE interval '0' END) FROM shop_money_events r
  WHERE r.kind='pay_request' AND r.supplier_id=supplier_profiles.user_id AND (r.data->>'amountMinor')::bigint>0
  AND (r.data->>'weekly' IS DISTINCT FROM 'true' OR COALESCE((SELECT (settings#>>'{shopMoney,overduePauseEnabled}')::boolean FROM platform_settings WHERE singleton),${['development','test'].includes(process.env.NODE_ENV)}))
  AND NOT EXISTS(SELECT 1 FROM shop_money_events c WHERE c.supplier_id=r.supplier_id
    AND c.kind IN ('pay_confirmed','pay_offset') AND c.data->>'requestId'=r.id)`;
