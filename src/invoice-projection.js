import { clientMoneyMinor } from './supplier-catalog.js';

/** Add client display amounts using only the immutable receipt's fee snapshot. */
export function clientInvoice(snapshot, { hideSupplierAmounts = snapshot.organizationDiscountRateBps > 0 } = {}) {
  const invoice = structuredClone(snapshot);
  const pricing = { settings: { serviceFeeRateBps: invoice.serviceFeeRateBps } };
  const priceSection = (section) => {
    section.clientItemSubtotalMinor = section.itemSubtotalMinor + (section.grossServiceFeeMinor ?? section.serviceFeeMinor);
    if (!Number.isSafeInteger(section.clientItemSubtotalMinor)) throw new RangeError('Invoice amount exceeds safe integer range');
    section.lines = (section.lines || []).map((source) => {
      const line = { ...source };
      line.clientUnitPriceMinor = clientMoneyMinor(pricing, line.unitPriceMinor);
      line.clientAmountMinor = clientMoneyMinor(pricing, line.amountMinor);
      if (hideSupplierAmounts) {
        delete line.unitPriceMinor;
        delete line.amountMinor;
      }
      return line;
    });
    for (const group of section.groups || []) priceSection(group);
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
