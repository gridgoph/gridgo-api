import { publicColourQuote } from './colour-projection.js';
import { splitVoucherMinor } from './voucher-money.js';
import { clientVoucher } from './voucher-projection.js';
import { clientMoneyMinor } from './supplier-catalog.js';

/** Add client display amounts using only the immutable receipt's fee snapshot. */
export function clientInvoice(snapshot, { exposeWorking = false, hideSupplierAmounts = snapshot.organizationDiscountRateBps > 0 || snapshot.serviceFeeSchedule?.version === 2 || snapshot.groups?.some(group => group.serviceFeeSchedule?.version === 2) } = {}) {
  const invoice = structuredClone(snapshot);
  const priceSection = (section) => {
    section.clientItemSubtotalMinor = section.itemSubtotalMinor + (section.grossServiceFeeMinor ?? section.serviceFeeMinor);
    if (!Number.isSafeInteger(section.clientItemSubtotalMinor)) throw new RangeError('Invoice amount exceeds safe integer range');
    const pricing = { settings: { serviceFeeRateBps: section.serviceFeeRateBps ?? invoice.serviceFeeRateBps,
      serviceFeeSchedule: section.serviceFeeSchedule } };
    const shares = section.serviceFeeSchedule?.version === 2
      ? splitVoucherMinor(section.grossServiceFeeMinor ?? section.serviceFeeMinor, (section.lines || []).map(line => line.amountMinor)) : null;
    section.lines = (section.lines || []).map((source, index) => {
      const line = { ...source };
      line.clientUnitPriceMinor = clientMoneyMinor(pricing, line.unitPriceMinor);
      line.clientAmountMinor = shares ? line.amountMinor + shares[index] : clientMoneyMinor(pricing, line.amountMinor);
      if (source.colourPricing) line.colourPricing = publicColourQuote(source.colourPricing,exposeWorking ? "ops_admin" : "client",line.clientAmountMinor);
      if (hideSupplierAmounts || (!exposeWorking && source.colourPricing?.pricedByColour)) {
        delete line.unitPriceMinor;
        delete line.amountMinor;
      }
      return line;
    });
    for (const group of section.groups || []) priceSection(group);
    if (section.groups?.length) section.lines = section.groups.flatMap(group => group.lines);
    if (!exposeWorking) {
      delete section.serviceFeeSchedule; delete section.serviceFeeWorking;
      for (const field of ['voucherSupplierMinor', 'gridgoSupplierTopupMinor', 'gridgoRiderTopupMinor']) delete section[field];
      if (section.voucher) section.voucher = clientVoucher(section.voucher);
    }
    if (hideSupplierAmounts) {
      delete section.itemSubtotalMinor;
      delete section.serviceFeeMinor;
      delete section.grossServiceFeeMinor;
      delete section.organizationDiscountRateBps;
      delete section.serviceFeeRateBps;
    }
  };
  priceSection(invoice);
  return invoice;
}
