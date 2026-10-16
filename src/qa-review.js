import { QA_CHECK_IDS } from "./artwork-gates.js";
import { artworkFileIdsFor } from "./artwork-attachments.js";

/** Artwork on the order row and every file attached to each line, once each, in first-seen order. */
export function orderArtworkFileIds(store, order) {
  const ids = [];
  const push = (id) => {
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  };
  for (const id of order?.artworkFileIds || []) push(id);
  for (const line of store?.orderLineItems || []) {
    if (line.orderId === order?.id) for (const id of artworkFileIdsFor(line)) push(id);
  }
  return ids;
}

/**
 * One audit per file. Download all is its own entry as well as one per file,
 * so the log shows both the batch and which files it saved.
 */
export function artworkDownloadAudits({ fileIds, all }) {
  const entries = [];
  if (all) {
    entries.push({ action: "order.artwork_download_all", detail: { fileIds: [...fileIds] } });
  }
  for (const fileId of fileIds) {
    entries.push({
      action: "order.artwork_download",
      detail: all ? { fileId, via: "all" } : { fileId },
    });
  }
  return entries;
}

export function qaTickAudit(checkId, checked) {
  if (!QA_CHECK_IDS.includes(checkId) || typeof checked !== "boolean") {
    const error = new Error("Choose one of the four checks.");
    error.status = 400;
    error.code = "invalid_qa_check";
    throw error;
  }
  return { action: "order.qa_tick", detail: { checkId, checked } };
}

const NOTE_MAX = 2000;

function clientNote(note) {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text || text.length > NOTE_MAX) {
    const error = new Error("Write what the client should know, in 2,000 characters or fewer.");
    error.status = 400;
    error.code = "invalid_qa_note";
    throw error;
  }
  return text;
}

/** Message and hold both tell the client in the support thread they already have. */
export function qaClientActionAudit(action, { note, threadId }) {
  if (action !== "message" && action !== "hold") {
    const error = new Error("Choose a message or a hold.");
    error.status = 400;
    error.code = "invalid_qa_action";
    throw error;
  }
  const text = clientNote(note);
  return {
    action: action === "hold" ? "order.qa_hold" : "order.qa_message",
    reason: text,
    detail: { threadId: threadId || null },
    clientText: action === "hold" ? `This order is on hold. ${text}` : text,
  };
}

export function qaRequestFileAudit(note) {
  return {
    action: "order.qa_request_file",
    reason: typeof note === "string" && note.trim() ? note.trim() : null,
    detail: { to: "client_correction" },
  };
}
