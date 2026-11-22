export const shopMoneyPolicy=(store,supplierId)=>(store.shopMoneyEvents||[]).filter(e=>e.kind==='policy'&&e.supplierId===supplierId).at(-1)?.data||{counterCashEnabled:false,version:0};
export const payRequestClosed=(store,id)=>(store.shopMoneyEvents||[]).some(e=>['pay_confirmed','pay_offset'].includes(e.kind)&&e.data.requestId===id);
export const activeShopTransferForKey=(store,key)=>(store.shopMoneyEvents||[]).find(e=>e.kind==='transfer_reserved'&&e.data.items.some(i=>i.key===key)
  &&!(store.shopMoneyEvents||[]).some(x=>['transfer_paid','transfer_cancelled'].includes(x.kind)&&x.data.transferId===e.id));
export function shopMoneyPaused(store,supplierId,at=new Date().toISOString()) {
  if(!shopMoneyPolicy(store,supplierId).counterCashEnabled)return false;
  return (store.shopMoneyEvents||[]).some(e=>e.kind==='pay_request'&&e.supplierId===supplierId&&e.data.amountMinor>0&&e.data.deadlineAt<=at&&!payRequestClosed(store,e.id));
}
