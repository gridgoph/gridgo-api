export function clientPaymentSnapshot(order) {
  const methods=[];
  if(order.cash)methods.push('cash_to_rider');
  else if(order.paymentMethod==='counter_cash')methods.push('counter_cash');
  else if(!order.coversOrderTotal)methods.push('in_app_qr');
  if(order.voucher||order.voucherDiscountMinor>0||order.coversOrderTotal)methods.push('voucher');
  return {methods,settlement:order.orderType==='express'?'daily':'staged'};
}
