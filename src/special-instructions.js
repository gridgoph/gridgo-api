const fail = () => { throw Object.assign(new Error('Special instructions must be text of at most 300 characters.'), { status: 400, code: 'invalid_special_instructions' }); };
export function specialInstructions(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || [...value.trim()].length > 300) fail();
  // Normalize compatibility forms and invisible separators before masking. Raw text is never retained.
  const masked = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').trim()
    .replace(/\b[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[masked]')
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>]*)?/giu, '[masked]')
    .replace(/(?:\+?\d[\d\s().-]{5,}\d)/gu, match => match.replace(/\D/g, '').length >= 7 ? '[masked]' : match)
    .replace(/@[\p{L}\p{N}_.-]+/gu, '[masked]')
    .replace(/\b(?:facebook|instagram|telegram|whatsapp|viber|tiktok|messenger|fb|ig)\s*[:=]\s*[^\s,;]+/giu, '[masked]');
  if ([...masked].length > 300) fail();
  return masked;
}
export function instructionLines(store, order, user = null) {
  return (store?.orderLineItems || []).filter(line => line.orderId === order.id && line.specialInstructions
      && (user?.role !== 'supplier' || !(store.orderJobs || []).some(j => j.orderId === order.id)
        || (store.orderJobs || []).some(j => j.id === line.jobId && j.supplierId === user.id)))
    .map(line => ({ lineItemId: line.id, text: line.specialInstructions }));
}
export function acknowledgeInstructions(store, order, user, body, at, audit) {
  const lines = instructionLines(store, order, user);
  if (!lines.length && !order.specialInstructions) return;
  if (body.specialInstructionsRead !== true) throw Object.assign(new Error('Read and tick the special instructions before accepting.'),
    { status: 409, code: 'special_instructions_acknowledgement_required' });
  order.specialInstructionsAcknowledgement = { supplierId: user.id, at, lines,
    ...(order.specialInstructions ? { text: order.specialInstructions } : {}) };
  audit(store, { actor: user, action: 'order.special_instructions_acknowledged', entityType: 'order', entityId: order.id,
    orderId: order.id, detail: order.specialInstructionsAcknowledgement });
}
