export const shopMoneyTables = [
  {name:'shop_money_ledger',keys:['id'],appendOnly:true,columns:['id','event_key','supplier_id','order_id','kind','owed_delta_minor','owing_delta_minor','created_at','position','data']},
  {name:'shop_money_events',keys:['id'],appendOnly:true,columns:['id','event_key','supplier_id','kind','created_at','position','data']},
];
export function shopMoneyRows(store, rows) {
  rows.shop_money_ledger=(store.shopMoneyLedger||[]).map((e,position)=>({position,id:e.id,event_key:e.key,supplier_id:e.supplierId,order_id:e.orderId??null,kind:e.kind,
    owed_delta_minor:e.owedDeltaMinor,owing_delta_minor:e.owingDeltaMinor,created_at:e.at,data:e.data||{}}));
  rows.shop_money_events=(store.shopMoneyEvents||[]).map((e,position)=>({position,id:e.id,event_key:e.key,supplier_id:e.supplierId??null,kind:e.kind,created_at:e.at,data:e.data||{}}));
}
export function loadShopMoneyRows(store,rows) {
  store.shopMoneyLedger=[...(rows.shop_money_ledger||[])].sort((a,b)=>a.position-b.position).map(e=>({id:e.id,key:e.event_key,supplierId:e.supplier_id,orderId:e.order_id,kind:e.kind,
    owedDeltaMinor:e.owed_delta_minor,owingDeltaMinor:e.owing_delta_minor,at:e.created_at,data:e.data}));
  store.shopMoneyEvents=[...(rows.shop_money_events||[])].sort((a,b)=>a.position-b.position).map(e=>({id:e.id,key:e.event_key,supplierId:e.supplier_id,kind:e.kind,at:e.created_at,data:e.data}));
}
