export const verificationLedgerTable={name:'supplier_verification_ledger',keys:['id'],appendOnly:true,
  columns:['id','supplier_id','order_id','payout_key','kind','amount_minor','net_amount_minor','recovery_minor','created_at','actor_id','position','data']};
export function verificationLedgerRows(store,rows) {
  rows.supplier_verification_ledger=(store.supplierVerificationLedger||[]).map((e,position)=>({position,id:e.id,supplier_id:e.supplierId,
    order_id:e.orderId??null,payout_key:e.payoutKey,kind:e.kind,amount_minor:e.amountMinor,net_amount_minor:e.data?.netAmountMinor??null,recovery_minor:e.data?.recoveryMinor??null,created_at:e.at,actor_id:e.actorId??null,
    data:Object.fromEntries(Object.entries(e.data||{}).filter(([key])=>!['netAmountMinor','recoveryMinor'].includes(key)))}));
}
export function loadVerificationLedgerRows(store,rows) {
  store.supplierVerificationLedger=[...(rows.supplier_verification_ledger||[])].sort((a,b)=>a.position-b.position).map(e=>({id:e.id,supplierId:e.supplier_id,
    orderId:e.order_id,payoutKey:e.payout_key,kind:e.kind,amountMinor:e.amount_minor,at:e.created_at,actorId:e.actor_id,data:{...e.data,...(e.net_amount_minor==null?{}:{netAmountMinor:e.net_amount_minor}),...(e.recovery_minor==null?{}:{recoveryMinor:e.recovery_minor})}}));
}
