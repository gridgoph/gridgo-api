/** An attachment is a rider's candidate until the completed delivery records consent. */
export function deliveryPackagePhotoId(store, order) {
  const reminder = store?.deliveryReminders?.find(row => row.orderId === order?.id);
  if (order?.fulfillmentMode !== 'delivery' || !order.deliveryEvidence?.recordedAt
    || reminder?.protocolVersion !== 1 || reminder.remindedClient !== true || reminder.clientAgreedToPhoto !== true
    || reminder.clientId !== order.clientId || reminder.riderId !== order.deliveryEvidence.riderId
    || Date.parse(reminder.deliveredAt) !== Date.parse(order.deliveryEvidence.recordedAt)) return null;
  return reminder.packagePhotoFileId || null;
}

/** Caller holds the delivery transaction; discarded candidates become unused uploads. */
export function finalizeDeliveryPackagePhotos(store, order, reminder) {
  const selected = reminder?.protocolVersion === 1 && reminder.remindedClient === true
    && reminder.clientAgreedToPhoto === true ? reminder.packagePhotoFileId : null;
  for (const file of store.files || []) {
    if (file.purpose !== 'delivery_package_photo' || file.fileId === selected) continue;
    file.references = (file.references || []).filter(ref => ref.type !== 'order' || ref.id !== order.id);
  }
  order.deliveryPackagePhotoFileIds = selected ? [selected] : [];
}
