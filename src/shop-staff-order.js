// An allowlist prevents future order money/private fields leaking through the
// legacy supplier projection. Nested production specs also discard money.
const FIELDS = new Set(['id', 'title', 'orderType', 'groupOrder', 'expressOrder', 'fileAccesses', 'state', 'createdAt', 'updatedAt', 'version', 'supplierId', 'riderId',
  'readyBy', 'promisedDate', 'fulfillmentMode', 'pickup', 'productionItems', 'jobDetails', 'timeline', 'actions',
  'artworkFileIds', 'mockupFileIds', 'artworkLinks', 'artworkAttachments', 'productionProgress', 'packingProgress',
  'shopAcceptance', 'shopHandover', 'pickupChecklist', 'pickupChat', 'clientShopChat', 'fileCheck', 'specialInstructions',
  'specialInstructionsAcknowledgement', 'specialInstructionLines', 'artworkPreviews', 'scheduling', 'refundHold', 'shopRecovery', 'workHeld', 'holdReasons',
  'transitionReadiness', 'handoverFlow', 'pickupReminder', 'forcedByGridgo', 'material', 'size', 'finish', 'artworkName', 'quantity', 'spec', 'specs', 'categoryCode', 'subcategoryCode', 'productName', 'productionFinishedAt']);
const pick = (record, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(record || {}, field)).map(field => [field, record[field]]));
export function staffExpressProjection(express) {
  if (!express || typeof express !== 'object') return null;
  return {
    ...pick(express, ['status', 'originalSupplierId', 'currentSupplierId', 'declineCount', 'acceptBy']),
    printSettings: (express.printSettings || []).map(print => ({
      ...pick(print, ['fileId', 'groupMemberId', 'groupMemberName', 'copies', 'colour', 'paper', 'paperStock', 'sides', 'layout', 'note', 'acceptedWarnings', 'orientation', 'colourMode', 'colourPages', 'planType', 'ink', 'paperColour', 'renderStatus', 'outputAlreadyApplied', 'productionPrint']),
      ...(print.fallback?{fallback:pick(print.fallback,['reason','colour','originalFile','message'])}:{}),
      ...(print.pagePricing?{pageMix:{counts:print.pagePricing.counts,pages:print.pagePricing.pages.map(page=>pick(page,['page','outputPage','measuredTier','tier','printColour','youSet','strongColourBps']))}}:{}),
      pages: pick(print.pages, ['total', 'range', 'printed']),
    })),
  };
}
const PAYMENT_CLASSIFICATIONS = new Map([['qr_manual', 'in_app'], ['cash', 'cash'], ['gridgo_voucher', 'voucher']]);
const FINANCIAL = /minor|price|cost|payout|earnings|commission|payment|settlement|allocation|discount|refundfinance|amount|ratebps|quote|invoice/i;
function workValue(value) {
  if (Array.isArray(value)) return value.map(workValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FINANCIAL.test(key)).map(([key, item]) => [key, workValue(item)]));
}
export function staffOrderProjection(record) {
  const result = workValue(Object.fromEntries(Object.entries(record).filter(([key]) => FIELDS.has(key))));
  // Free-text payment history can contain amounts; only work events and the
  // deliberately bounded actor history belong in the staff UI.
  result.timeline = (record.timeline || []).map(({ at, state, actor }) => ({ at, state, ...(actor ? { actor } : {}) }));
  if (record.expressOrder) result.expressOrder = staffExpressProjection(record.expressOrder);
  const method = record.payments?.initial?.method ?? record.paymentMethod;
  const classification = PAYMENT_CLASSIFICATIONS.get(method);
  if (classification) {
    result.paymentMethod = method;
    result.paymentClassification = classification;
  }
  return result;
}
