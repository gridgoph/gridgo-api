import { cashSettings } from './cash-policy.js';
import { isReviewData } from './review-data.js';
import { publicCatalogItem } from './supplier-catalog.js';
import { expressLinePrice } from './express-orders.js';

export const EXPRESS_SERVICES = ['stapling', 'binding', 'lamination', 'rush'];
export const EXPRESS_PAYMENT_METHODS = ['cash', 'qr_ph'];
const PRICE_BUCKETS = 10;

/** Shop logo for the printer card. Home printers never expose shop media. */
export function expressShopLogo(store, supplierId, home) {
  if (home) return null;
  const media = (store.supplierShopMedia || []).find(row => row.supplierId === supplierId && row.slot === 'logo');
  const file = media && (store.files || []).find(row => row.fileId === media.fileId);
  return file?.state === 'ready' && file.objectKey ? { fileId: file.fileId, url: `/catalog/media/${file.fileId}` } : null;
}

/** Extra services a printer offers, from its live capabilities and public listings. */
export function expressShopServices(store, supplierId, at) {
  const services = (store.supplierServices || []).filter(row => row.supplierId === supplierId && row.state === 'live');
  const own = (store.catalogItems || []).filter(item => item.supplierId === supplierId && item.active !== false);
  const laminationGroups = new Set((store.catalogOptions || []).filter(option => option.active !== false
    && option.specBinding?.fieldCode === 'finish' && (option.specBinding.valueCode ?? option.specBinding.value) === 'lamination')
    .map(option => option.optionGroupId));
  const laminationItems = new Set((store.catalogOptionGroups || []).filter(group => laminationGroups.has(group.id)).map(group => group.catalogItemId));
  const isLamination = item => item.templateData?.templateId === 'tpl_lamination' || laminationItems.has(item.id);
  const isBinding = item => item.subcategoryCode === 'binding_hardbound' && item.templateData?.templateId !== 'tpl_lamination'
    && !/stapl|laminat/i.test(item.name || '');
  // Only listings that could add a service pay for the public-visibility check.
  const visible = test => own.some(item => test(item) && publicCatalogItem(store, item, { at }));
  const found = {
    stapling: services.some(row => row.documentCapabilities?.finishing?.stapling),
    binding: services.some(row => row.documentCapabilities?.finishing?.binding) || visible(isBinding),
    lamination: visible(isLamination),
    rush: services.some(row => row.rushEnabled === true),
  };
  return EXPRESS_SERVICES.filter(code => found[code]);
}

/**
 * Payment methods this client could use with this printer, by the same gates
 * checkout applies. QR is always offered. Cash follows the cash checkout rules
 * (switch on, individual client, delivery, verified shop, under the limit);
 * home printers take QR only.
 */
export function expressPaymentMethods(store, user, { home, verified, fulfillmentMode, printAndFeeMinor = null }) {
  const cash = cashSettings(store.settings);
  const barred = (store.orders || []).some(o => o.clientId === user?.id && o.cashProgress?.noShowApprovedAt && !o.cashProgress.repaymentConfirmedAt);
  const cashAllowed = !home && verified && cash.enabled === true && fulfillmentMode === 'delivery'
    && user?.role === 'client' && user.accountType === 'individual' && !isReviewData(user) && !barred
    && (printAndFeeMinor == null || (Number.isSafeInteger(printAndFeeMinor) && printAndFeeMinor < cash.limitMinor));
  return cashAllowed ? ['cash', 'qr_ph'] : ['qr_ph'];
}

/**
 * The client's price for one printer, read from the checkout quote of a
 * preview draft. `totalMinor` is the quote total checkout charges; the
 * per-page price is the shop's own page rate for this order.
 */
export function expressCardPrice(quote, lines) {
  if (quote?.status !== 'priced' || !Number.isSafeInteger(quote.totalMinor) || !lines.length) return null;
  const priced = lines.map(line => ({ line, ...expressLinePrice(line) }));
  const printedPages = priced.reduce((sum, row) => sum + row.line.documentPages.printed * row.quantity, 0);
  const printingMinor = priced.reduce((sum, row) => sum + row.lineSubtotalMinor, 0);
  const rates = new Set(priced.flatMap(row => row.line.expressPrint?.pagePricing?.pages.map(p=>p.priceMinor) || [row.unitRateMinor]));
  return {
    totalMinor: quote.totalMinor,
    printedPages,
    perPageMinor: rates.size === 1 ? [...rates][0] : Math.ceil(printingMinor / printedPages),
    perPageMixed: rates.size > 1,
  };
}

function histogram(values) {
  if (!values.length) return null;
  const minMinor = Math.min(...values), maxMinor = Math.max(...values);
  const width = Math.max(1, Math.ceil((maxMinor - minMinor + 1) / PRICE_BUCKETS));
  const buckets = [];
  for (let from = minMinor; from <= maxMinor; from += width) buckets.push({ fromMinor: from, toMinor: Math.min(from + width - 1, maxMinor), count: 0 });
  for (const value of values) buckets[Math.floor((value - minMinor) / width)].count++;
  return { minMinor, maxMinor, buckets };
}

/** Counts and price spread for the Filters panel, over the printers before type/verified filters. */
export function expressFilterData(rows) {
  const count = test => rows.filter(test).length;
  const priced = rows.filter(row => row.selectable && row.price);
  return {
    printers: rows.length,
    verified: count(row => row.verified),
    openNow: count(row => row.isOpenNow),
    topShops: count(row => row.topShop),
    printerType: { shop: count(row => row.printerType === 'shop'), home: count(row => row.printerType === 'home') },
    services: Object.fromEntries(EXPRESS_SERVICES.map(code => [code, count(row => row.services?.includes(code))])),
    paymentMethods: Object.fromEntries(EXPRESS_PAYMENT_METHODS.map(code => [code, count(row => row.paymentMethods?.includes(code))])),
    price: priced.length ? {
      total: histogram(priced.map(row => row.price.totalMinor)),
      perPage: histogram(priced.map(row => row.price.perPageMinor)),
    } : null,
  };
}
