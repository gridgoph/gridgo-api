// An allowlist prevents future order money/private fields leaking through the
// legacy supplier projection. Nested production specs also discard money.
const FIELDS = new Set(['id', 'title', 'state', 'createdAt', 'updatedAt', 'version', 'supplierId', 'riderId',
  'readyBy', 'promisedDate', 'fulfillmentMode', 'pickup', 'productionItems', 'jobDetails', 'timeline', 'actions',
  'artworkFileIds', 'mockupFileIds', 'artworkLinks', 'artworkAttachments', 'productionProgress', 'packingProgress',
  'shopAcceptance', 'shopHandover', 'pickupChecklist', 'pickupChat', 'clientShopChat', 'fileCheck', 'specialInstructions',
  'specialInstructionsAcknowledgement', 'specialInstructionLines', 'artworkPreviews', 'scheduling', 'refundHold', 'shopRecovery', 'workHeld', 'holdReasons',
  'transitionReadiness', 'handoverFlow', 'pickupReminder', 'forcedByGridgo', 'material', 'size', 'finish', 'artworkName', 'quantity', 'spec', 'specs', 'categoryCode', 'subcategoryCode', 'productName', 'productionFinishedAt']);
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
  return result;
}
