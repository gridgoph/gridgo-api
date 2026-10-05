import { retainApprovedPhotos } from "./catalog-review-state.js";
import { identityHasMembership } from "./authorization-context.js";
import { CatalogError, assertExpectedVersion, bumpVersion, catalogItemBlockers, catalogGroupsForItem, privateCatalogItem, publicCatalogItem, listingStartersFor } from "./supplier-catalog.js";
import { privilegedAdminMemberships, queueInvalidate } from "./notifications.js";

function fail(status, code, message, details = {}) { throw new CatalogError(status, code, message, details); }
function role(user, roles) {
  if (!user) fail(401, "unauthorized", "Sign in first.");
  if (!roles.some(value => identityHasMembership(user, value))) fail(403, "forbidden", "This membership cannot review listings.");
}
function text(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(400, `${field}_required`, `Send ${field} (1–${max} characters).`);
  return value.trim();
}
function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_catalog_item", "Send a JSON object.");
  return body;
}
export function listingReviewBlockers(store, item) {
  const blockers = catalogItemBlockers(store, item);
  const specs = catalogGroupsForItem(store, item.id).filter(group => (group.kind || "spec") === "spec");
  if (!specs.length || !specs.some(group => group.required && group.options.some(option => option.active !== false && String(option.label || "").trim()))) blockers.push("specs_required");
  return blockers;
}
function complete(store, item) {
  const blockers = listingReviewBlockers(store, item);
  if (blockers.length) fail(409, "listing_incomplete", "Complete specs, variants and photos before review.", { blockers });
}
export function catalogReviewNotice(store, item, { id, now }, type) {
  const recipients = [...privilegedAdminMemberships(store), { userId: item.supplierId, role: "supplier" }];
  store.notifications ||= [];
  for (const recipient of recipients) store.notifications.push({
    id: id("ntf"), userId: recipient.userId, appRole: recipient.role, type,
    title: type === "catalog_review_pending" ? "Listing awaiting review" : "Listing review updated",
    body: item.reviewReason || "Open your listing to see its review status.", at: now(), read: false,
  });
  queueInvalidate(store, { resource: "catalog", id: item.id, supplierId: item.supplierId, userIds: recipients.map(row => row.userId) });
}

export async function routeCatalogReview({ req, url, store, user, readBody, id, now, audit }) {
  const path = url.pathname;
  const staff = path.startsWith("/ops/catalog-reviews") || path.startsWith("/ops/product-type-requests");
  const own = path === "/me/product-types" || path.startsWith("/me/product-type-requests") || /^\/me\/catalog-items\/[^/]+\/submit$/.test(path);
  if (!staff && !own) return null;
  role(user, staff ? ["ops_admin", "super_admin"] : ["supplier"]);
  const context = { id, now };
  const changed = (action, entityType, record, details = {}) => audit?.(store, { actor: user, action, entityType, entityId: record.id,
    detail: { status: record.reviewStatus || record.status, reason: record.reviewReason || record.reason || null, ...details },
  });
  if (path === "/me/product-types" && req.method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length > 120) fail(400, "invalid_query", "Search is limited to 120 characters.");
    const photosByType = new Map();
    for (const item of store.catalogItems || []) {
      const approved = publicCatalogItem(store, item);
      if (approved && !photosByType.has(approved.subcategoryCode)) photosByType.set(approved.subcategoryCode, approved.photos.slice(0, 1));
    }
    return { status: 200, body: { productTypes: (store.taxonomy?.subcategories || [])
      .filter(row => row.active !== false && (store.taxonomy?.categories || []).some(category => category.code === row.categoryCode && category.active !== false))
      .filter(row => !q || `${row.name} ${row.code} ${(row.examples || []).join(" ")}`.toLowerCase().includes(q))
      .map(row => ({ code: row.code, name: row.name, categoryCode: row.categoryCode, imageUrl: row.imageUrl || null,
        photos: photosByType.get(row.code) || [], starters: listingStartersFor(store, row.code) })) } };
  }
  if (path === "/ops/catalog-reviews" && req.method === "GET") {
    const status = url.searchParams.get("status") || "pending";
    if (!["pending", "approved", "needs_revision"].includes(status)) fail(400, "invalid_review_status", "Choose a review state.");
    const after = url.searchParams.get("after") || "";
    const items = (store.catalogItems || []).filter(item => (item.reviewStatus || "approved") === status && item.id > after)
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 51);
    return { status: 200, body: { items: items.slice(0, 50).map(item => ({ ...privateCatalogItem(store, item), reviewBlockers: listingReviewBlockers(store, item) })),
      nextCursor: items.length > 50 ? items[49].id : null } };
  }
  const match = path.match(/^\/(ops\/catalog-reviews|me\/catalog-items)\/([^/]+)\/(decision|submit)$/);
  if (match && req.method === "POST") {
    if ((staff && match[3] !== "decision") || (!staff && match[3] !== "submit")) return null;
    const item = (store.catalogItems || []).find(row => row.id === decodeURIComponent(match[2]) && (staff || row.supplierId === user.id));
    if (!item) fail(404, "catalog_item_not_found", "Listing not found.");
    const body = bodyObject(await readBody(req));
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    if (!staff) {
      complete(store, item);
      if ((item.reviewStatus || "approved") === "approved") fail(409, "listing_already_approved", "Edit the listing to submit a revision.");
      item.reviewStatus = "pending"; item.reviewReason = null;
    } else {
      if (item.reviewStatus !== "pending") fail(409, "listing_not_pending", "Refresh the review queue.");
      if (!["approved", "needs_revision"].includes(body.status)) fail(400, "invalid_review_status", "Choose approved or needs_revision.");
      if (body.status === "approved") {
        complete(store, item);
        if (body.photosUnbranded !== true) fail(400, "photo_review_required", "Confirm every photo has no watermark, logo or shop branding.");
        item.approvedSnapshot = null;
        retainApprovedPhotos(store, item);
        item.reviewReason = null;
      } else item.reviewReason = text(body.reason, "reason", 2000);
      item.reviewStatus = body.status;
      item.reviewedAt = now(); item.reviewedBy = user.id;
    }
    bumpVersion(item, now());
    changed(staff ? "catalog_item.review" : "catalog_item.submit", "supplier_catalog_item", item, {
      reviewedVersion: body.expectedVersion, photosUnbranded: body.photosUnbranded === true,
      photoFileIds: (store.catalogItemPhotos || []).filter(row => row.catalogItemId === item.id).map(row => row.fileId),
    });
    catalogReviewNotice(store, item, context, staff ? "catalog_review_decided" : "catalog_review_pending");
    return { status: 200, body: { item: privateCatalogItem(store, item) }, mutated: true };
  }
  if (/^\/(me|ops)\/product-type-requests(?:\/[^/]+\/decision)?$/.test(path)) {
    store.productTypeRequests ||= [];
    if (req.method === "GET" && !path.endsWith("/decision")) {
      const status = url.searchParams.get("status");
      if (status && !["pending", "approved", "needs_revision"].includes(status)) fail(400, "invalid_review_status", "Choose a review state.");
      const after = url.searchParams.get("after") || "";
      const requests = store.productTypeRequests.filter(row => (staff || row.supplierId === user.id) && (!status || row.status === status) && row.id > after)
        .sort((a,b) => a.id.localeCompare(b.id)).slice(0, 51);
      return { status: 200, body: { requests: requests.slice(0, 50), nextCursor: requests.length > 50 ? requests[49].id : null } };
    }
    if (req.method !== "POST") return null;
    const body = bodyObject(await readBody(req));
    if (!staff && path === "/me/product-type-requests") {
      const categoryCode = text(body.categoryCode, "categoryCode", 100);
      if (!(store.taxonomy.categories || []).some(row => row.code === categoryCode && row.active !== false)) fail(400, "invalid_category_code", "Choose an active category.");
      const request = { id: id("ptr"), supplierId: user.id, categoryCode, name: text(body.name, "name", 120),
        description: text(body.description, "description", 2000), status: "pending", reason: null, version: 1, createdAt: now(), updatedAt: now() };
      store.productTypeRequests.push(request);
      changed("product_type.request", "product_type_request", request);
      catalogReviewNotice(store, { ...request, reviewReason: null }, context, "catalog_review_pending");
      return { status: 201, body: { request }, mutated: true };
    }
    if (staff && path.endsWith("/decision")) {
      const request = store.productTypeRequests.find(row => row.id === decodeURIComponent(path.split("/")[3]));
      if (!request) fail(404, "product_type_request_not_found", "Request not found.");
      assertExpectedVersion(req, body, "product_type_request_stale", request.version);
      if (request.status !== "pending") fail(409, "product_type_request_not_pending", "This request has been decided.");
      if (!["approved", "needs_revision"].includes(body.status)) fail(400, "invalid_review_status", "Choose approved or needs_revision.");
      if (body.status === "approved") {
        const code = text(body.code, "code", 100);
        if (!/^[a-z][a-z0-9_]*$/.test(code)) fail(400, "invalid_subcategory_code", "Use a lowercase code.");
        if (store.taxonomy.subcategories.some(row => row.code === code)) fail(409, "product_type_exists", "That product type already exists.");
        if (!store.taxonomy.categories.some(row => row.code === request.categoryCode && row.active !== false)) fail(409, "category_inactive", "Choose an active category before review.");
        store.taxonomy.subcategories.push({ id: id("taxs"), code, categoryCode: request.categoryCode, name: request.name, examples: [], active: true, sortOrder: store.taxonomy.subcategories.length });
        request.productTypeCode = code;
      } else request.reason = text(body.reason, "reason", 2000);
      request.status = body.status; request.reviewedBy = user.id; request.reviewedAt = now(); bumpVersion(request, now());
      changed("product_type.review", "product_type_request", request);
      catalogReviewNotice(store, { ...request, reviewReason: request.reason }, context, "catalog_review_decided");
      return { status: 200, body: { request }, mutated: true };
    }
  }
  return null;
}
