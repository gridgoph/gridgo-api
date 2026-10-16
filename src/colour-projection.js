import { splitVoucherMinor } from './voucher-money.js';
import { serviceFeeMoney } from './service-fee.js';

/** Page display amounts cover all ordered copies/sets, so odd centavos can be
 * allocated exactly without fractional money or independently marking up sheets. */
export function publicColourQuote(quote, role, clientLineSubtotalMinor = null) {
  if (!quote || !['client','supplier','ops_admin','super_admin'].includes(role)) return null;
  const result = structuredClone(quote);
  if (role === 'supplier') return result;
  const complete = Number.isSafeInteger(clientLineSubtotalMinor) && clientLineSubtotalMinor >= 0
    && (quote.pricedByColour ? Number.isSafeInteger(quote.lineSubtotalMinor) : true)
    && quote.pages.length > 0 && quote.pages.every(page => !quote.pricedByColour || Number.isSafeInteger(page.sheetPriceMinor));
  const amounts = complete ? splitVoucherMinor(clientLineSubtotalMinor,
    quote.pages.map(page => quote.pricedByColour ? page.sheetPriceMinor : 1)) : quote.pages.map(() => null);
  result.clientLineSubtotalMinor = complete ? clientLineSubtotalMinor : null;
  result.pagePriceBasis = 'per_sheet_all_in';
  result.pages = result.pages.map((page,index) => {
    const total = amounts[index];
    const quantity = Number.isSafeInteger(quote.quantity) && quote.quantity > 0 ? BigInt(quote.quantity) : 1n;
    const clientSheetPriceMinor = total == null ? null : Number((BigInt(total)+quantity/2n)/quantity);
    const clientPageRoundingMinor = total == null ? null : Number(BigInt(total)-BigInt(clientSheetPriceMinor)*quantity);
    if (role === 'client') page.sheetPriceMinor = clientSheetPriceMinor;
    return {...page,clientSheetPriceMinor,clientPageTotalMinor:total,clientPageRoundingMinor};
  });
  if (role === 'client') delete result.lineSubtotalMinor;
  return result;
}

/** Customers need offered tiers, not the shop's private rate matrix. */
export function publicColourListing(pricing) {
  if (!pricing) return null;
  return {sizes:pricing.sizes.map(({prices,...size}) => ({...structuredClone(size),offeredTiers:Object.keys(prices)}))};
}

/** Match the original invoice's all-in line allocation using frozen money. */
export function orderColourClientAmount(store,order,line) {
  if (!order || !line) return null;
  if (order.serviceFeeSchedule?.version !== 2) {
    const schedule = order.serviceFeeSchedule || {version:1,rateBps:order.serviceFeeRateBps ?? 0};
    return line.lineSubtotalMinor + serviceFeeMoney(line.lineSubtotalMinor,schedule).grossServiceFeeMinor;
  }
  const lines = (store.orderLineItems || []).filter(row => row.orderId === order.id)
    .sort((a,b) => (a.sortOrder ?? 0)-(b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  const index = lines.findIndex(row => row.id === line.id);
  if (index < 0) return null;
  const shares = splitVoucherMinor(order.grossServiceFeeMinor ?? order.serviceFeeMinor,lines.map(row => row.lineSubtotalMinor));
  return line.lineSubtotalMinor + shares[index];
}

/** Original line allocation plus frozen incremental fees on this line's colour
 * corrections. Proposed terms stay separate from applied production evidence. */
export function publicColourChange(store,order,row,role) {
  const correction = row?.data?.colourCorrection;
  if (!correction) return null;
  if (role === 'supplier') return structuredClone(correction);
  if (!['client','ops_admin','super_admin'].includes(role)) return null;
  const line = (store.orderLineItems || []).find(line => line.id === row.lineItemId && line.orderId === order?.id);
  const base = orderColourClientAmount(store,order,line);
  const history = (store.orderChanges || []).filter(change => change.orderId === order.id);
  const index = history.findIndex(change => change.id === row.id);
  const priorFee = history.slice(0,index < 0 ? 0 : index).filter(change => change.lineItemId === row.lineItemId
    && change.status === 'applied' && change.data.colourCorrection).reduce((sum,change) => sum+change.feeMinor,0);
  const originalClientLineSubtotalMinor = base == null ? null : correction.originalLineSubtotalMinor + (base-line.lineSubtotalMinor) + priorFee;
  const correctedClientLineSubtotalMinor = originalClientLineSubtotalMinor == null ? null
    : originalClientLineSubtotalMinor + correction.correctedLineSubtotalMinor-correction.originalLineSubtotalMinor + row.feeMinor;
  const projected = publicColourQuote({...correction,pricedByColour:true,lineSubtotalMinor:correction.correctedLineSubtotalMinor},role,correctedClientLineSubtotalMinor);
  if (role === 'client') {delete projected.originalLineSubtotalMinor;delete projected.correctedLineSubtotalMinor;}
  return {...projected,originalClientLineSubtotalMinor,correctedClientLineSubtotalMinor};
}
