/** Shared evidence rule for packing and the client progress gallery. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SHOP_PROOF_CODES = new Set(["production_started", "printing", "packaging_qc"]);

export function productionPhotoFiles(store, order) {
  return (store?.files || []).filter((file) =>
    file.state === "ready" && file.ownerId === order.supplierId
    && IMAGE_TYPES.has(file.detectedContentType) && file.objectKey
    && (file.references || []).some((ref) => ref.type === "order" && ref.id === order.id
      && (file.purpose === "production_photo"
        || (file.purpose === "fulfilment_proof" && SHOP_PROOF_CODES.has(ref.milestoneCode)))),
  );
}

export function productionProgressFor(store, order) {
  const photos = productionPhotoFiles(store, order).map((file) => ({
    fileId: file.fileId, contentType: file.detectedContentType, at: file.readyAt || file.createdAt,
  }));
  return { status: photos.length ? "photos_available" : "waiting_for_photo", photos };
}

/** The caller must authorize each file exactly as a direct artwork download. */
export async function signProductionPhotos(record, { findFile, authorizeRead, presignGet }) {
  if (!record?.productionProgress) return;
  const visible = [];
  for (const photo of record.productionProgress.photos) {
    const file = findFile(photo.fileId);
    try { authorizeRead(file); } catch { continue; }
    try {
      const signed = await presignGet(file.objectKey);
      photo.downloadUrl = signed.url;
      photo.downloadUrlExpiresAt = signed.expiresAt;
    } catch {
      // Keep evidence visible during storage outages. /files/:id/download-url
      // can be retried; a signing outage does not mean no photo was submitted.
    }
    visible.push(photo);
  }
  record.productionProgress = { status: visible.length ? "photos_available" : "waiting_for_photo", photos: visible };
}

const PROGRESS_LABELS = Object.freeze({
  draft: "Draft saved", submitted: "Order submitted", needs_qa: "Artwork being checked",
  client_correction: "Artwork needs a change", proof_approval: "Proof ready for approval",
  approved_for_matching: "Finding a print shop", supplier_assigned: "Print shop assigned",
  supplier_accepted: "Quote ready", awaiting_checkout: "Ready for checkout",
  awaiting_initial_payment: "Waiting for payment", awaiting_downpayment: "Waiting for payment",
  initial_payment_review: "Payment being checked", downpayment_review: "Payment being checked",
  payment_authorized: "Ready for production", production: "In production",
  supplier_self_qc: "Checking and packing your order", ready_for_dispatch: "Ready for dispatch",
  rider_assigned: "Rider assigned", picked_up: "Picked up from the shop",
  out_for_delivery: "Out for delivery", awaiting_collection: "Ready for collection",
  delivered: "Order received", issue_window_open: "Order received; please check your items",
  completed: "Order completed", cancelled: "Order cancelled",
});

/** Allowlisted progress only: raw notes, actors, proof codes and arbitrary event
 * fields are internal. This also sanitizes historical rows without rewriting them.
 */
export function publicProgressTimeline(timeline) {
  const result = [];
  for (const entry of timeline || []) {
    if (entry.milestoneCode || !Object.hasOwn(PROGRESS_LABELS, entry.state)) continue;
    if (result.at(-1)?.state === entry.state) continue;
    result.push({ at: entry.at, state: entry.state, note: PROGRESS_LABELS[entry.state] });
  }
  return result;
}
