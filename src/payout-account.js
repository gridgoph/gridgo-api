import { identityHasMembership } from "./authorization-context.js";
import { findFile, markFileDeletePending } from "./attachments.js";
import { philippineMobileNumber } from "./phone.js";
import {
  CatalogError,
  assertExpectedVersion,
  bumpVersion,
} from "./supplier-catalog.js";

/**
 * Where a shop wants to be paid.
 *
 * When Operations releases a payout, a person opens a wallet app and scans
 * the shop's receiving QR - the same plate that sits on the shop counter.
 * This record is that plate plus the words a person needs to check they are
 * paying the right shop: which wallet, whose name the wallet shows back, and
 * the number behind it.
 *
 * The picture is an ordinary stored file with purpose `supplier_payout_qr`.
 * It is bound here by id rather than attached through `/files/:id/attach`,
 * the same way the platform's own receiving QR is activated, so one PATCH
 * can create the whole account in a single, versioned write.
 */

export const PAYOUT_PROVIDERS = Object.freeze(["gcash", "maya", "bank", "other"]);
const PROVIDER_SET = new Set(PAYOUT_PROVIDERS);
const WALLET_PROVIDERS = new Set(["gcash", "maya"]);
export const PAYOUT_QR_PURPOSE = "supplier_payout_qr";
export const PAYOUT_QR_REFERENCE_TYPE = "supplier_payout_account";
const ME_ROUTE = "/me/payout-account";

function fail(status, code, message, details = {}) {
  throw new CatalogError(status, code, message, details);
}

function optionalText(value, field, maxLength) {
  if (value != null && typeof value !== "string") {
    fail(400, "invalid_payout_account", `${field} must be a string.`, { field });
  }
  const text = String(value ?? "");
  if (text.length > maxLength) {
    fail(400, "invalid_payout_account", `${field} is too long.`, { field, maxLength });
  }
  return text;
}

function requiredText(value, field, maxLength = 200) {
  const text = optionalText(value, field, maxLength).trim();
  if (!text) fail(400, "invalid_payout_account", `${field} is required.`, { field });
  return text;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_payout_account", "body must be a JSON object.", { field: "body" });
  }
  return value;
}

function requireSupplier(user) {
  if (!user || !identityHasMembership(user, "supplier")) {
    fail(403, "forbidden", "A supplier membership is required.");
  }
}

export function isPrivatePayoutAccountRoute(pathname) {
  return pathname === ME_ROUTE;
}

export function payoutAccountFor(store, supplierId) {
  return (store.supplierPayoutAccounts || []).find((row) => row.supplierId === supplierId) || null;
}

function readyQrFile(store, account) {
  if (!account?.qrFileId) return null;
  const file = findFile(store, account.qrFileId);
  if (
    !file
    || file.purpose !== PAYOUT_QR_PURPOSE
    || file.state !== "ready"
    || file.deletedAt
    || file.deleteRequestedAt
    || !file.objectKey
  ) {
    return null;
  }
  return file;
}

/**
 * The account as its owner and Operations read it. The file id is enough for
 * either side to ask `/files/:id/download-url` for the bytes; nothing here
 * ever carries an object key.
 */
export function payoutAccountProjection(store, account) {
  if (!account) return null;
  const file = readyQrFile(store, account);
  return {
    supplierId: account.supplierId,
    provider: account.provider,
    accountName: account.accountName,
    accountNumber: account.accountNumber ?? null,
    institution: account.institution ?? null,
    qr: file
      ? {
        fileId: file.fileId,
        originalFilename: file.originalFilename ?? null,
        detectedContentType: file.detectedContentType ?? null,
        size: file.size ?? null,
        readyAt: file.readyAt ?? null,
      }
      : null,
    version: account.version || 1,
    updatedAt: account.updatedAt,
  };
}

/**
 * What the release desk needs beside the milestone it is about to release:
 * the account plus the shop's name, so the person scanning can match the
 * name the wallet app shows back.
 */
export function opsPayoutAccountProjection(store, supplierId) {
  if (!supplierId) return null;
  const account = payoutAccountFor(store, supplierId);
  if (!account) return null;
  const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
  const owner = (store.users || []).find((row) => row.id === supplierId);
  return {
    ...payoutAccountProjection(store, account),
    shopName: profile?.shopName ?? owner?.supplierName ?? owner?.name ?? null,
  };
}

function providerValue(value) {
  const provider = requiredText(value, "provider", 40).toLowerCase();
  if (!PROVIDER_SET.has(provider)) {
    fail(400, "invalid_payout_account", "Choose gcash, maya, bank, or other.", {
      field: "provider",
      allowed: PAYOUT_PROVIDERS,
    });
  }
  return provider;
}

function accountNumberValue(value, provider) {
  const typed = optionalText(value, "accountNumber", 60).trim();
  if (!typed) return null;
  if (WALLET_PROVIDERS.has(provider)) {
    return philippineMobileNumber(typed, "accountNumber", {
      code: "invalid_payout_account",
      blankMessage: "Enter the mobile number this wallet is registered to.",
    });
  }
  return typed;
}

function institutionValue(value) {
  const text = optionalText(value, "institution", 80).trim();
  return text || null;
}

function stripQrReference(store, account) {
  if (!account?.qrFileId) return null;
  const previous = findFile(store, account.qrFileId);
  if (previous) {
    previous.references = (previous.references || []).filter(
      (reference) => !(reference.type === PAYOUT_QR_REFERENCE_TYPE && reference.id === account.supplierId),
    );
  }
  account.qrFileId = null;
  return previous;
}

function retireQrFile(store, account, user, at) {
  const previous = stripQrReference(store, account);
  if (previous && previous.state === "ready" && !previous.deletedAt && !previous.deleteRequestedAt) {
    markFileDeletePending(previous, user, at);
  }
}

/**
 * Find one uploaded plate the caller may bind. The file must be the shop's
 * own ready `supplier_payout_qr` upload that nothing else has claimed, so a
 * shop can never point its payouts at a picture it does not own. Runs before
 * anything moves so a refused picture leaves no half-written account behind.
 */
function resolveQrFile(store, current, fileId, user) {
  if (current?.qrFileId === fileId) return null;
  const file = findFile(store, fileId);
  if (
    !file
    || file.purpose !== PAYOUT_QR_PURPOSE
    || file.ownerId !== user.id
    || file.state !== "ready"
    || file.deletedAt
    || file.deleteRequestedAt
    || !file.objectKey
  ) {
    fail(
      400,
      "invalid_payout_qr",
      "Upload a JPEG, PNG or WebP of your receiving QR with purpose supplier_payout_qr, then save that file as your payout QR.",
      { field: "qrFileId" },
    );
  }
  if ((file.references || []).length) {
    fail(409, "file_already_attached", "That picture is already in use. Upload the QR again and save the new file.", {
      field: "qrFileId",
    });
  }
  return file;
}

function bindQrFile(store, account, file, user, at) {
  retireQrFile(store, account, user, at);
  if (!Array.isArray(file.references)) file.references = [];
  file.references.push({ type: PAYOUT_QR_REFERENCE_TYPE, id: account.supplierId, field: "qr" });
  account.qrFileId = file.fileId;
}

function auditChange(audit, store, user, action, detail) {
  if (typeof audit === "function") {
    audit(store, { actor: user, action, entityType: "payout_account", entityId: user.id, detail });
  }
}

export async function routePayoutAccount({ req, url, store, user, readBody, now, audit }) {
  const { pathname } = url;
  if (pathname !== ME_ROUTE || !["GET", "PATCH", "DELETE"].includes(req.method)) return null;

  requireSupplier(user);
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === user.id);
  if (!profile) fail(404, "supplier_profile_not_found", "Complete supplier enrollment first.");
  if (!Array.isArray(store.supplierPayoutAccounts)) store.supplierPayoutAccounts = [];
  const current = payoutAccountFor(store, user.id);

  if (req.method === "GET") {
    return { status: 200, body: { payoutAccount: payoutAccountProjection(store, current) } };
  }

  if (req.method === "DELETE") {
    if (!current) return { status: 200, body: { payoutAccount: null } };
    assertExpectedVersion(req, {}, "payout_account_stale", current.version || 1, url);
    const at = now();
    retireQrFile(store, current, user, at);
    store.supplierPayoutAccounts = store.supplierPayoutAccounts.filter((row) => row !== current);
    auditChange(audit, store, user, "payout_account.delete", { provider: current.provider });
    return { status: 200, body: { payoutAccount: null }, mutated: true };
  }

  const body = record(await readBody(req));
  if (current) {
    assertExpectedVersion(req, body, "payout_account_stale", current.version || 1, url);
  } else if (body.expectedVersion != null && body.expectedVersion !== 0) {
    fail(409, "payout_account_stale", "This shop has no payout account yet. Reload and set it up again.", {
      expectedVersion: body.expectedVersion,
      currentVersion: 0,
    });
  }

  // Read every field before anything moves so a mistyped number cannot leave
  // a half-applied edit behind.
  const provider = Object.hasOwn(body, "provider") || !current
    ? providerValue(body.provider)
    : current.provider;
  const accountName = Object.hasOwn(body, "accountName") || !current
    ? requiredText(body.accountName, "accountName", 120)
    : current.accountName;
  const hasNumber = Object.hasOwn(body, "accountNumber");
  const accountNumber = hasNumber || (current && provider !== current.provider)
    ? accountNumberValue(hasNumber ? body.accountNumber : current?.accountNumber, provider)
    : current?.accountNumber ?? null;
  const hasInstitution = Object.hasOwn(body, "institution");
  const institution = hasInstitution ? institutionValue(body.institution) : current?.institution ?? null;
  const hasQr = Object.hasOwn(body, "qrFileId");
  const qrFileId = hasQr && body.qrFileId != null ? requiredText(body.qrFileId, "qrFileId", 120) : null;
  const qrFile = qrFileId ? resolveQrFile(store, current, qrFileId, user) : null;

  const at = now();
  let account = current;
  if (!account) {
    account = {
      supplierId: user.id,
      provider,
      accountName,
      accountNumber,
      institution,
      qrFileId: null,
      version: 1,
      updatedAt: at,
    };
    store.supplierPayoutAccounts.push(account);
  } else {
    account.provider = provider;
    account.accountName = accountName;
    account.accountNumber = accountNumber;
    account.institution = institution;
    bumpVersion(account, at);
  }
  if (hasQr) {
    if (qrFile) bindQrFile(store, account, qrFile, user, at);
    else if (!qrFileId) retireQrFile(store, account, user, at);
  }
  auditChange(audit, store, user, current ? "payout_account.update" : "payout_account.create", {
    provider: account.provider,
    qrFileId: account.qrFileId,
  });
  return {
    status: current ? 200 : 201,
    body: { payoutAccount: payoutAccountProjection(store, account) },
    mutated: true,
  };
}
