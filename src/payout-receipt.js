import { findFile } from "./attachments.js";

/**
 * What Operations keeps after paying a shop.
 *
 * A release is a person scanning the shop's QR and sending from the GRIDGO
 * wallet. The wallet then shows a receipt with a reference number, and that
 * screenshot is the only proof the money actually moved. It is bound to the
 * share it paid for, beside the Proof of Fulfilment that justified it, so a
 * dispute six weeks later is settled by opening the order, not by searching
 * a phone's camera roll.
 *
 * The picture is an ordinary stored file with purpose `payout_receipt`. It
 * is bound here by id rather than through `/files/:id/attach`, the same way
 * a shop's payout QR is, so the upload and the release stay two calls with
 * one owner.
 */

export const PAYOUT_RECEIPT_PURPOSE = "payout_receipt";
export const PAYOUT_RECEIPT_FIELD = "payoutReceiptFileIds";
const MAX_REFERENCE_LENGTH = 80;

class PayoutReceiptError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "PayoutReceiptError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = {}) {
  throw new PayoutReceiptError(status, code, message, details);
}

/** The wallet's own reference, as typed. Blank means none was given. */
export function paymentReferenceValue(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    fail(400, "invalid_payout_reference", "reference must be a string.", { field: "reference" });
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_REFERENCE_LENGTH) {
    fail(400, "invalid_payout_reference", "That reference is too long. Copy only the reference number the wallet shows.", {
      field: "reference",
      maxLength: MAX_REFERENCE_LENGTH,
    });
  }
  return text;
}

/**
 * Find one uploaded receipt the caller may bind. It must be the caller's own
 * ready `payout_receipt` upload that nothing else has claimed. Runs before
 * the share moves, so a refused picture leaves the share unreleased.
 */
export function resolvePayoutReceipt(store, fileId, user) {
  if (fileId == null) return null;
  const id = typeof fileId === "string" ? fileId.trim() : "";
  if (!id) {
    fail(400, "invalid_payout_receipt", "receiptFileId must be a file id.", { field: "receiptFileId" });
  }
  const file = findFile(store, id);
  if (
    !file
    || file.purpose !== PAYOUT_RECEIPT_PURPOSE
    || file.ownerId !== user?.id
    || file.state !== "ready"
    || file.deletedAt
    || file.deleteRequestedAt
    || !file.objectKey
  ) {
    fail(
      400,
      "invalid_payout_receipt",
      "Upload a JPEG, PNG or WebP of the wallet receipt with purpose payout_receipt, then release the share with that fileId.",
      { field: "receiptFileId" },
    );
  }
  if ((file.references || []).length) {
    fail(409, "file_already_attached", "That receipt is already bound to a release. Upload the screenshot again.", {
      field: "receiptFileId",
    });
  }
  return file;
}

/** Bind a resolved receipt to the share it paid for. */
export function bindPayoutReceipt(order, milestone, file) {
  if (!Array.isArray(file.references)) file.references = [];
  file.references.push({ type: "order", id: order.id, field: PAYOUT_RECEIPT_FIELD, milestoneCode: milestone.code });
  if (!Array.isArray(order[PAYOUT_RECEIPT_FIELD])) order[PAYOUT_RECEIPT_FIELD] = [];
  if (!order[PAYOUT_RECEIPT_FIELD].includes(file.fileId)) order[PAYOUT_RECEIPT_FIELD].push(file.fileId);
  milestone.receiptFileId = file.fileId;
  return milestone;
}
