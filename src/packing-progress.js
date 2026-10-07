/** Packing is separate evidence: a production or payout photo cannot satisfy it. */
export function packingPhotoFiles(store, order) {
  return (store?.files || []).filter((file) =>
    file.state === "ready" && file.ownerId === order.supplierId
    && file.purpose === "packing_photo" && file.objectKey
    && ["image/jpeg", "image/png", "image/webp"].includes(file.detectedContentType)
    && (file.references || []).some((ref) => ref.type === "order" && ref.id === order.id));
}

export function packingProgressFor(store, order) {
  const photos = packingPhotoFiles(store, order).map((file) => ({
    fileId: file.fileId, contentType: file.detectedContentType, at: file.readyAt || file.createdAt,
  }));
  return { status: photos.length ? "photos_available" : "waiting_for_photo", photos };
}
