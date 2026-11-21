/** Fixed Express lock-screen fields; credentials, files and client facts stay private. */
export const isExpressDocumentOrder = order => order?.orderType === 'express' && order?.expressOrder?.version === 1;
export function expressOfferFields(order, { staff = false } = {}) {
  const pages = (order.expressOrder?.printSettings || []).reduce((sum, file) => sum + (file.pages?.printed || 0) * (file.copies || 1), 0);
  return { pages, fulfillmentMode: order.fulfillmentMode,
    acceptBy: order.shopAcceptance?.deadlineAt,
    ...(!staff && Number.isSafeInteger(order.supplierSubtotalMinor) ? { earningsMinor: order.supplierSubtotalMinor } : {}) };
}
export function expressOfferCopy(fields, at) {
  const { earningsMinor, pages, fulfillmentMode, acceptBy } = fields;
  const remaining = Math.max(0, Math.ceil((Date.parse(acceptBy) - Date.parse(at)) / 60000));
  const amount = Number.isSafeInteger(earningsMinor)
    ? ` — earn PHP ${Math.trunc(earningsMinor / 100)}.${String(Math.abs(earningsMinor % 100)).padStart(2, '0')}` : '';
  return { title: `New Express job${amount}`,
    body: `${pages} pages · ${fulfillmentMode === 'pickup' ? 'Client pickup' : 'Rider delivery'} · ${Number.isFinite(remaining) ? remaining : 5} min left. Accept or see job.` };
}
