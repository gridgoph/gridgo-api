import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_SIZE = 200 * 1024 * 1024;
export const MAX_MULTIPART_SIZE = MAX_FILE_SIZE + 1024 * 1024;

const KINDS = new Set(["artwork", "fulfilment_proof", "delivery_photo", "service_image", "verification_document"]);
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
export const VERIFICATION_DOCUMENT_TYPES = Object.freeze(["business_permit", "valid_id", "sample_work"]);
const VERIFICATION_DOCUMENT_TYPE_SET = new Set(VERIFICATION_DOCUMENT_TYPES);
export const PURPOSE_POLICIES = Object.freeze({
  artwork: { roles: ["client"], maxBytes: MAX_FILE_SIZE, contentTypes: [...CONTENT_TYPES] },
  fulfilment_proof: { roles: ["supplier", "rider"], maxBytes: MAX_FILE_SIZE, contentTypes: [...CONTENT_TYPES] },
  delivery_photo: {
    roles: ["rider"],
    maxBytes: 20 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  service_image: {
    roles: ["supplier"],
    maxBytes: 20 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  verification_document: {
    roles: ["supplier"],
    maxBytes: 20 * 1024 * 1024,
    contentTypes: [...CONTENT_TYPES],
  },
});
const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream"]);
const EXTENSION_CONTENT_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);
const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);
const DELIVERY_PHOTO_STATES = new Set([
  "rider_assigned",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "issue_window_open",
]);
const FULFILMENT_MILESTONE_ACTOR = Object.freeze({
  printing: "supplier",
  packaging_qc: "supplier",
  delivered: "rider",
});

export class AttachmentError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "AttachmentError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new AttachmentError(status, code, message, details);
}

function parseDisposition(value) {
  const result = {};
  for (const match of value.matchAll(/(?:^|;)\s*([^=;]+)="((?:\\.|[^"])*)"/g)) {
    result[match[1].trim().toLowerCase()] = match[2].replace(/\\(["\\])/g, "$1");
  }
  return result;
}

function multipartBoundary(contentType) {
  const typeMatch = /^multipart\/form-data\s*;(.*)$/i.exec(String(contentType || ""));
  if (!typeMatch) {
    fail(
      415,
      "multipart_required",
      "Choose an image or PDF and upload it as multipart/form-data using the `file` form field.",
    );
  }
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(`;${typeMatch[1]}`);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) {
    fail(400, "invalid_multipart", "The upload boundary is missing or invalid. Re-select the file and try again.");
  }
  return boundary;
}

export async function parseMultipartStream(stream, contentType, options = {}) {
  const boundary = multipartBoundary(contentType);
  const tempDir = options.tempDir || path.join(process.cwd(), ".tmp", "uploads");
  const maxFileSize = options.maxFileSize || MAX_FILE_SIZE;
  const maxRequestSize = maxFileSize + 1024 * 1024;
  const firstDelimiter = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const fields = {};
  let file = null;
  let fileHandle = null;
  let tempPath = null;
  let current = null;
  let buffer = Buffer.alloc(0);
  let state = "start";
  let complete = false;
  let requestSize = 0;
  let partCount = 0;

  await fs.mkdir(tempDir, { recursive: true });

  async function cleanup() {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
      fileHandle = null;
    }
    const candidate = file?.tempPath || tempPath;
    if (candidate) await fs.unlink(candidate).catch(() => {});
  }

  async function startPart(headerBytes) {
    partCount += 1;
    if (partCount > 2) {
      fail(400, "invalid_multipart", "Upload exactly one `purpose` field and one `file` field.");
    }
    const headers = {};
    for (const line of headerBytes.toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = parseDisposition(headers["content-disposition"] || "");
    if (!disposition.name) {
      fail(400, "invalid_multipart", "A form field has no name. Re-select the file and try again.");
    }
    if (disposition.filename != null) {
      if (disposition.name !== "file" || file || fileHandle) {
        fail(400, "file_required", "Upload one file at a time using the `file` form field.");
      }
      tempPath = path.join(
        tempDir,
        `upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.part`,
      );
      fileHandle = await fs.open(tempPath, "wx", 0o600);
      current = {
        type: "file",
        originalFilename: disposition.filename,
        declaredContentType: String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase(),
        size: 0,
        sniffBytes: Buffer.alloc(0),
      };
      return;
    }
    if (disposition.name !== "purpose") {
      fail(
        400,
        "unexpected_form_field",
        `Remove the unsupported upload form field: ${disposition.name}. Send only \`purpose\` and \`file\`.`,
        { field: disposition.name },
      );
    }
    current = { type: "field", name: disposition.name, chunks: [], size: 0 };
  }

  async function writePart(bytes) {
    if (!bytes.length) return;
    if (current.type === "field") {
      current.size += bytes.length;
      if (current.size > 256) {
        fail(400, "invalid_multipart", "The upload purpose is too long. Send one supported purpose value.");
      }
      current.chunks.push(Buffer.from(bytes));
      return;
    }
    current.size += bytes.length;
    if (current.size > maxFileSize) {
      fail(413, "file_too_large", "The selected file is larger than 200 MiB. Choose a smaller file and try again.", {
        maxBytes: MAX_FILE_SIZE,
        maxMiB: 200,
      });
    }
    if (current.sniffBytes.length < 32) {
      const needed = 32 - current.sniffBytes.length;
      current.sniffBytes = Buffer.concat([current.sniffBytes, bytes.subarray(0, needed)]);
    }
    await fileHandle.write(bytes);
  }

  async function finishPart() {
    if (current.type === "field") {
      if (Object.hasOwn(fields, current.name)) {
        fail(400, "invalid_multipart", `The upload repeats the \`${current.name}\` form field. Send each field once.`);
      }
      fields[current.name] = Buffer.concat(current.chunks).toString("utf8");
    } else {
      await fileHandle.close();
      fileHandle = null;
      file = {
        originalFilename: current.originalFilename,
        declaredContentType: current.declaredContentType,
        size: current.size,
        sniffBytes: current.sniffBytes,
        tempPath,
      };
    }
    current = null;
  }

  async function processBuffer() {
    while (true) {
      if (state === "start") {
        if (buffer.length < firstDelimiter.length + 2) return;
        if (!buffer.subarray(0, firstDelimiter.length).equals(firstDelimiter)) {
          fail(400, "invalid_multipart", "The upload body is incomplete. Re-select the file and try again.");
        }
        buffer = buffer.subarray(firstDelimiter.length);
        if (!buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          fail(400, "invalid_multipart", "The upload body is malformed. Re-select the file and try again.");
        }
        buffer = buffer.subarray(2);
        state = "headers";
      } else if (state === "headers") {
        const headerEnd = buffer.indexOf(headerSeparator);
        if (headerEnd < 0) {
          if (buffer.length > 16 * 1024) {
            fail(400, "invalid_multipart", "The upload headers are too large. Re-select the file and try again.");
          }
          return;
        }
        await startPart(buffer.subarray(0, headerEnd));
        buffer = buffer.subarray(headerEnd + headerSeparator.length);
        state = "body";
      } else if (state === "body") {
        const boundaryIndex = buffer.indexOf(delimiter);
        if (boundaryIndex < 0) {
          const retained = delimiter.length + 2;
          if (buffer.length <= retained) return;
          const flushLength = buffer.length - retained;
          await writePart(buffer.subarray(0, flushLength));
          buffer = buffer.subarray(flushLength);
          return;
        }
        await writePart(buffer.subarray(0, boundaryIndex));
        await finishPart();
        buffer = buffer.subarray(boundaryIndex + delimiter.length);
        state = "boundary";
      } else if (state === "boundary") {
        if (buffer.length < 2) return;
        if (buffer.subarray(0, 2).equals(Buffer.from("--"))) {
          buffer = buffer.subarray(2);
          complete = true;
          state = "done";
          return;
        }
        if (!buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          fail(400, "invalid_multipart", "The upload boundary is malformed. Re-select the file and try again.");
        }
        buffer = buffer.subarray(2);
        state = "headers";
      } else {
        return;
      }
    }
  }

  try {
    for await (const chunk of stream) {
      requestSize += chunk.length;
      if (requestSize > maxRequestSize) {
        fail(413, "file_too_large", "The selected file is larger than 200 MiB. Choose a smaller file and try again.", {
          maxBytes: MAX_FILE_SIZE,
          maxMiB: 200,
        });
      }
      buffer = Buffer.concat([buffer, chunk]);
      await processBuffer();
    }
    await processBuffer();
    if (!complete) {
      fail(400, "invalid_multipart", "The upload body ended early. Re-select the file and try again.");
    }
    if (!file) fail(400, "file_required", "Choose an image or PDF and upload it using the `file` form field.");
    return { fields, file };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function validateUpload(file, purpose = "artwork") {
  const policy = PURPOSE_POLICIES[purpose];
  if (!policy) {
    fail(400, "invalid_file_purpose", "Choose one file purpose: artwork, fulfilment_proof, delivery_photo, service_image, or verification_document.", {
      allowedPurposes: Object.keys(PURPOSE_POLICIES),
    });
  }
  if (!file || !Number.isFinite(file.size)) {
    fail(400, "file_required", "Choose an image or PDF and upload it using the `file` form field.");
  }
  if (file.size === 0) {
    fail(400, "file_empty", "The selected file is empty. Choose a file that contains an image or PDF and try again.");
  }
  if (file.size > policy.maxBytes) {
    const maxMiB = policy.maxBytes / 1024 / 1024;
    fail(413, "file_too_large", `The selected ${purpose} file is larger than ${maxMiB} MiB. Choose a smaller file and try again.`, {
      purpose,
      maxBytes: policy.maxBytes,
      maxMiB,
    });
  }
  const originalFilename = String(file.originalFilename || "").trim();
  if (!originalFilename) {
    fail(400, "filename_required", "The selected file has no filename. Rename it and try again.");
  }

  const extension = path.extname(originalFilename).toLowerCase();
  const sniffBytes = Buffer.from(file.sniffBytes || []);
  const sniffedContentType = sniffContentType(sniffBytes);
  if (HEIC_EXTENSIONS.has(extension) || sniffedContentType === "image/heic") {
    fail(
      415,
      "heic_not_supported",
      "HEIC files are not supported. Export or capture the image as JPEG or PNG, then try again.",
      { allowedContentTypes: [...CONTENT_TYPES] },
    );
  }

  let declaredContentType = String(file.declaredContentType || "").trim().toLowerCase();
  if (declaredContentType === "image/jpg") declaredContentType = "image/jpeg";
  if (!GENERIC_CONTENT_TYPES.has(declaredContentType) && !CONTENT_TYPES.has(declaredContentType)) {
    fail(
      415,
      "content_type_not_allowed",
      "This file type is not supported. Choose a JPEG, PNG, WebP, or PDF file and try again.",
      { allowedContentTypes: [...CONTENT_TYPES] },
    );
  }

  const extensionContentType = EXTENSION_CONTENT_TYPES.get(extension);
  const explicitTypeMismatch =
    !GENERIC_CONTENT_TYPES.has(declaredContentType) && declaredContentType !== sniffedContentType;
  if (!extensionContentType || !sniffedContentType || extensionContentType !== sniffedContentType || explicitTypeMismatch) {
    fail(
      415,
      "file_type_mismatch",
      "The filename, file contents, and reported type do not agree. Export the file as JPEG, PNG, WebP, or PDF and try again.",
      {
        extension,
        declaredContentType: declaredContentType || null,
        sniffedContentType,
      },
    );
  }
  if (!policy.contentTypes.includes(sniffedContentType)) {
    fail(
      415,
      "purpose_media_type_not_allowed",
      `${purpose} does not accept ${sniffedContentType}. Choose ${policy.contentTypes.join(", ")} and try again.`,
      { purpose, detectedContentType: sniffedContentType, allowedContentTypes: policy.contentTypes },
    );
  }
  return sniffedContentType;
}

function sniffContentType(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

function forbidden() {
  fail(403, "forbidden", "This file belongs to another account or record. Open a file attached to one of your own records.");
}

// File registry contract. Parent records contain only opaque file IDs; object keys never cross the API boundary.
export function authorizeFileUpload(user, purpose) {
  const policy = PURPOSE_POLICIES[purpose];
  if (!policy) {
    fail(400, "invalid_file_purpose", "Choose one file purpose: artwork, fulfilment_proof, delivery_photo, service_image, or verification_document.", {
      allowedPurposes: Object.keys(PURPOSE_POLICIES),
    });
  }
  if (!user || !policy.roles.includes(user.role)) forbidden();
}

export function createPendingFile({ fileId, objectKey, user, purpose, file, detectedContentType, at }) {
  authorizeFileUpload(user, purpose);
  return {
    fileId,
    objectKey,
    ownerId: user.id,
    purpose,
    originalFilename: file.originalFilename,
    declaredContentType: file.declaredContentType || null,
    detectedContentType,
    size: file.size,
    state: "pending_upload",
    createdAt: at,
    readyAt: null,
    deleteRequestedAt: null,
    deletedAt: null,
    references: [],
  };
}

export function markFileReady(file, at) {
  if (file?.state !== "pending_upload") {
    fail(409, "file_state_conflict", "This file is not waiting for storage. Refresh its status before trying again.");
  }
  file.state = "ready";
  file.readyAt = at;
  return file;
}

export function markFileDeletePending(file, user, at) {
  if (!file) fail(404, "file_not_found", "That file no longer exists. Refresh your uploads and try again.");
  if (file.purpose === "verification_document") {
    if (!user || user.role !== "supplier" || user.id !== file.ownerId) forbidden();
  } else if (!user || (user.id !== file.ownerId && !["ops_admin", "super_admin"].includes(user.role))) {
    forbidden();
  }
  if (file.state === "deleted" || file.state === "delete_pending") return file;
  if (file.state !== "ready") {
    fail(409, "file_state_conflict", "This file is not ready to delete. Refresh its status and try again.");
  }
  if ((file.references || []).length) {
    fail(409, "file_in_use", "This file is attached to a GRIDGO record. Remove that reference before deleting the file.");
  }
  file.state = "delete_pending";
  file.deleteRequestedAt = at;
  return file;
}

export function markFileDeleted(file, at) {
  if (file?.state !== "delete_pending" && file?.state !== "pending_upload") {
    fail(409, "file_state_conflict", "This file is not pending deletion. Refresh its status and try again.");
  }
  file.state = "deleted";
  file.deletedAt = at;
  file.objectKey = null;
  return file;
}

export function publicFile(file) {
  if (!file) return null;
  return {
    fileId: file.fileId,
    purpose: file.purpose,
    originalFilename: file.originalFilename,
    declaredContentType: file.declaredContentType,
    detectedContentType: file.detectedContentType,
    size: file.size,
    ownerId: file.ownerId,
    state: file.state,
    createdAt: file.createdAt,
    readyAt: file.readyAt,
    deleteRequestedAt: file.deleteRequestedAt,
    deletedAt: file.deletedAt,
    references: (file.references || []).map((reference) => ({ ...reference })),
    ...(file.verificationDocumentType ? { verificationDocumentType: file.verificationDocumentType } : {}),
  };
}

export function findFile(store, fileId) {
  return (store.files || []).find((file) => file.fileId === fileId) || null;
}

export function resolveFileTarget(store, purpose, body, user = null) {
  if (!KINDS.has(purpose)) {
    fail(400, "invalid_file_purpose", "Choose one supported file purpose and try again.");
  }
  const allowedFields = purpose === "verification_document"
    ? ["documentType", "replaceFileId"]
    : purpose === "service_image"
    ? ["supplierServiceId"]
    : purpose === "fulfilment_proof"
      ? ["orderId", "milestoneCode"]
      : ["orderId"];
  const requiredField = allowedFields[0];
  const unexpectedField = Object.keys(body || {}).find((field) => !allowedFields.includes(field));
  if (unexpectedField) {
    fail(
      400,
      "unexpected_target_field",
      `Remove \`${unexpectedField}\`. This file purpose accepts only: ${allowedFields.join(", ")}.`,
      { field: unexpectedField, allowedFields },
    );
  }
  if (purpose === "verification_document") {
    const documentType = String(body?.documentType || "");
    if (!VERIFICATION_DOCUMENT_TYPE_SET.has(documentType)) {
      fail(
        400,
        "invalid_verification_document_type",
        "Choose business_permit, valid_id, or sample_work for this verification document.",
        { allowed: VERIFICATION_DOCUMENT_TYPES },
      );
    }
    const record = (store.users || []).find((item) => item.id === user?.id);
    if (!record || record.role !== "supplier") forbidden();
    const attachedIds = Array.isArray(record.verificationDocumentFileIds)
      ? record.verificationDocumentFileIds
      : [];
    const currentFiles = attachedIds
      .map((fileId) => (store.files || []).find((item) => item.fileId === fileId))
      .filter(Boolean);
    const currentType = (candidate) =>
      candidate.verificationDocumentType ||
      (candidate.references || []).find(
        (reference) => reference.type === "user" && reference.id === record.id,
      )?.documentType;
    const replaceFileId = body?.replaceFileId == null ? null : String(body.replaceFileId);
    let replacedFiles = [];
    if (replaceFileId) {
      const replaced = currentFiles.find((candidate) => candidate.fileId === replaceFileId);
      if (!replaced || currentType(replaced) !== documentType) {
        fail(
          409,
          "verification_document_replacement_mismatch",
          "The selected document is not attached in this verification slot. Refresh the documents and choose the matching file.",
          { replaceFileId, documentType },
        );
      }
      replacedFiles = [replaced];
    } else if (documentType !== "sample_work") {
      replacedFiles = currentFiles.filter((candidate) => currentType(candidate) === documentType);
    }
    return { type: "user", record, documentType, replacedFiles };
  }
  if (purpose === "service_image") {
    if (!body?.supplierServiceId) {
      fail(400, "attachment_target_required", "Add `supplierServiceId` so GRIDGO knows which service receives this image.", {
        requiredField: "supplierServiceId",
      });
    }
    const record = (store.supplierServices || []).find((item) => item.id === body.supplierServiceId);
    if (!record) fail(404, "service_not_found", "That supplier service no longer exists. Refresh services and try again.");
    return { type: "supplier_service", record };
  }
  if (!body?.orderId) {
    fail(400, "attachment_target_required", "Add `orderId` so GRIDGO knows which order receives this file.", {
      requiredField: "orderId",
    });
  }
  const record = (store.orders || []).find((item) => item.id === body.orderId);
  if (!record) fail(404, "order_not_found", "That order no longer exists. Refresh orders and try again.");
  if (purpose === "fulfilment_proof") {
    const milestoneCode = String(body?.milestoneCode || "");
    if (!milestoneCode) {
      fail(
        400,
        "attachment_target_required",
        "Add milestoneCode so GRIDGO knows which payout milestone receives this Proof of Fulfilment.",
        { requiredField: "milestoneCode" },
      );
    }
    const milestone = (record.payoutMilestones || []).find((item) => item.code === milestoneCode);
    if (!milestone || milestoneCode === "retention") {
      fail(
        400,
        "invalid_milestone_code",
        "Choose printing, packaging_qc, or delivered for this Proof of Fulfilment.",
        { milestoneCode, allowed: Object.keys(FULFILMENT_MILESTONE_ACTOR) },
      );
    }
    return { type: "order", record, milestoneCode };
  }
  return { type: "order", record };
}

export function authorizeFileAttachOwner(user, file) {
  if (!file) fail(404, "file_not_found", "That file no longer exists. Refresh your uploads and try again.");
  if (!user || file.ownerId !== user.id) forbidden();
  if (file.state !== "ready") {
    fail(409, "file_not_ready", "This upload is not ready to attach. Wait for a successful upload response and try again.", {
      state: file.state,
    });
  }
  if ((file.references || []).length) {
    fail(
      409,
      "file_already_attached",
      "This file is already attached to a GRIDGO record. Upload a new file for a different record.",
    );
  }
  const policy = PURPOSE_POLICIES[file.purpose];
  if (!policy || !policy.contentTypes.includes(file.detectedContentType) || !file.objectKey || file.size <= 0) {
    fail(409, "file_metadata_invalid", "This file record is incomplete or does not match its purpose. Upload the file again.");
  }
}

export function authorizeFileAttach(user, file, target) {
  authorizeFileAttachOwner(user, file);
  const record = target?.record;
  if (file.purpose === "artwork") {
    if (target?.type !== "order" || user.role !== "client" || record.clientId !== user.id) forbidden();
    return;
  }
  if (file.purpose === "fulfilment_proof") {
    if (target?.type !== "order") forbidden();
    const requiredRole = FULFILMENT_MILESTONE_ACTOR[target.milestoneCode];
    if (!requiredRole || user.role !== requiredRole) forbidden();
    if (requiredRole === "supplier" && record.supplierId !== user.id) forbidden();
    if (requiredRole === "rider" && record.riderId !== user.id) forbidden();
    return;
  }
  if (file.purpose === "delivery_photo") {
    if (target?.type !== "order" || user.role !== "rider" || record.riderId !== user.id) forbidden();
    if (!DELIVERY_PHOTO_STATES.has(record.state)) {
      fail(
        409,
        "delivery_photo_upload_not_allowed",
        "Delivery photos can be attached only after a rider is assigned. Open the active delivery and try again.",
        { state: record.state, allowedStates: [...DELIVERY_PHOTO_STATES] },
      );
    }
    return;
  }
  if (file.purpose === "service_image") {
    if (target?.type !== "supplier_service" || user.role !== "supplier" || record.supplierId !== user.id) forbidden();
    return;
  }
  if (file.purpose === "verification_document") {
    if (target?.type !== "user" || user.role !== "supplier" || target.record.id !== user.id) forbidden();
    if (!VERIFICATION_DOCUMENT_TYPE_SET.has(target.documentType)) {
      fail(409, "file_metadata_invalid", "This verification document has no valid document type. Upload the file again.");
    }
    return;
  }
  fail(409, "file_metadata_invalid", "This file purpose cannot be attached. Upload the file again.");
}

export function attachFileReference(file, target) {
  const map = {
    artwork: "artworkFileIds",
    fulfilment_proof: "fulfilmentProofFileIds",
    delivery_photo: "deliveryPhotoFileIds",
    service_image: "imageFileIds",
    verification_document: "verificationDocumentFileIds",
  };
  const field = map[file.purpose];
  if (!field) fail(409, "file_metadata_invalid", "This file purpose cannot be attached. Upload the file again.");
  if (!Array.isArray(target.record[field])) target.record[field] = [];
  if (file.purpose === "verification_document") {
    for (const replaced of target.replacedFiles || []) {
      target.record[field] = target.record[field].filter((fileId) => fileId !== replaced.fileId);
      replaced.references = (replaced.references || []).filter(
        (reference) => !(reference.type === "user" && reference.id === target.record.id && reference.field === field),
      );
    }
    file.verificationDocumentType = target.documentType;
  }
  const existingReference = (file.references || []).find(
    (reference) => reference.type === target.type && reference.id === target.record.id && reference.field === field,
  );
  if (!target.record[field].includes(file.fileId)) target.record[field].push(file.fileId);
  if (!Array.isArray(file.references)) file.references = [];
  if (!existingReference) {
    file.references.push({
      type: target.type,
      id: target.record.id,
      field,
      ...(target.milestoneCode ? { milestoneCode: target.milestoneCode } : {}),
      ...(target.documentType ? { documentType: target.documentType } : {}),
    });
  }
  if (file.purpose === "fulfilment_proof") {
    const milestone = (target.record.payoutMilestones || []).find((item) => item.code === target.milestoneCode);
    if (!milestone) fail(409, "milestone_not_found", "That payout milestone no longer exists. Refresh the order and try again.");
    if (!Array.isArray(milestone.pofFileIds)) milestone.pofFileIds = [];
    if (!milestone.pofFileIds.includes(file.fileId)) milestone.pofFileIds.push(file.fileId);
    if (milestone.status === "pending_pof") milestone.status = "pof_attached";
    if (target.milestoneCode === "delivered") {
      const retention = (target.record.payoutMilestones || []).find((item) => item.code === "retention");
      if (retention) {
        if (!Array.isArray(retention.pofFileIds)) retention.pofFileIds = [];
        if (!retention.pofFileIds.includes(file.fileId)) retention.pofFileIds.push(file.fileId);
        if (retention.status === "pending_pof") retention.status = "pof_attached";
      }
    }
  }
  return field;
}

function canReadReference(user, store, reference) {
  if (reference.type === "supplier_service") {
    const service = (store.supplierServices || []).find((item) => item.id === reference.id);
    if (!service) return false;
    if (service.state === "live") return true;
    return user.role === "supplier" && service.supplierId === user.id;
  }
  const order = (store.orders || []).find((item) => item.id === reference.id);
  if (!order) return false;
  return (
    (user.role === "client" && order.clientId === user.id) ||
    (user.role === "supplier" && order.supplierId === user.id) ||
    (user.role === "rider" && order.riderId === user.id)
  );
}

export function authorizeFileRead(user, store, file) {
  if (!file || file.state !== "ready") {
    fail(404, "file_not_found", "That ready file no longer exists. Refresh the record and try again.");
  }
  if (!user) forbidden();
  if (["ops_admin", "super_admin"].includes(user.role)) return;
  if (file.purpose === "verification_document") {
    if (user.role === "supplier" && file.ownerId === user.id) return;
    forbidden();
  }
  if (file.ownerId === user.id) return;
  if ((file.references || []).some((reference) => canReadReference(user, store, reference))) return;
  forbidden();
}

export function backfillFiles(store) {
  let changed = false;
  if (!Array.isArray(store.files)) {
    store.files = [];
    changed = true;
  }
  for (const order of store.orders || []) {
    for (const field of ["artworkFileIds", "proofFileIds", "fulfilmentProofFileIds", "deliveryPhotoFileIds"]) {
      if (!Array.isArray(order[field])) {
        order[field] = [];
        changed = true;
      }
    }
  }
  for (const service of store.supplierServices || []) {
    if (!Array.isArray(service.imageFileIds)) {
      service.imageFileIds = [];
      changed = true;
    }
  }
  for (const user of store.users || []) {
    if (user.role === "supplier" && !Array.isArray(user.verificationDocumentFileIds)) {
      user.verificationDocumentFileIds = [];
      changed = true;
    }
  }
  return changed;
}
