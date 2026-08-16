const BASELINE = Symbol("postgresStoreBaseline");

function without(record, keys) {
  const result = { ...record };
  for (const key of keys) delete result[key];
  return result;
}

function present(record, key, value) {
  if (value !== null && value !== undefined) record[key] = value;
}

function money(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a JavaScript safe integer in minor units`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rowKey(row, columns) {
  return columns.map((column) => String(row[column])).join("\u0000");
}

const TABLES = [
  { name: "platform_settings", keys: ["singleton"], columns: ["singleton", "version", "settings"] },
  { name: "users", keys: ["id"], columns: ["id", "clerk_user_id", "email", "name", "phone", "role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label", "created_at", "position", "data"] },
  { name: "catalog_products", keys: ["id"], columns: ["id", "name", "family", "base_price_minor", "unit", "position", "data"] },
  { name: "taxonomy_categories", keys: ["id"], columns: ["id", "code", "name", "active", "sort_order", "position", "data"] },
  { name: "taxonomy_category_aliases", keys: ["code"], columns: ["code", "category_code", "position", "data"] },
  { name: "taxonomy_subcategories", keys: ["id"], columns: ["id", "code", "category_code", "name", "active", "sort_order", "position", "data"] },
  { name: "taxonomy_materials", keys: ["id"], columns: ["id", "code", "name", "category_codes", "active", "position", "data"] },
  { name: "taxonomy_finishes", keys: ["id"], columns: ["id", "code", "name", "category_codes", "active", "position", "data"] },
  { name: "zones", keys: ["id"], columns: ["id", "code", "name", "active", "position", "data"] },
  { name: "supplier_services", keys: ["id"], columns: ["id", "supplier_id", "category_code", "state", "reference_rate_minor", "turnaround_hours", "created_at", "updated_at", "position", "data"] },
  { name: "orders", keys: ["id"], columns: ["id", "client_id", "supplier_id", "rider_id", "product_id", "state", "zone_code", "supplier_price_minor", "commission_minor", "subtotal_minor", "delivery_fee_minor", "total_minor", "downpayment_minor", "balance_minor", "payout_hold", "pickup_lat", "pickup_lng", "pickup_label", "dropoff_lat", "dropoff_lng", "dropoff_label", "issue_window_opened_at", "issue_window_expires_at", "created_at", "updated_at", "position", "data"] },
  { name: "order_payments", keys: ["order_id", "code"], columns: ["order_id", "code", "amount_minor", "method", "status", "position", "data"] },
  { name: "payout_milestones", keys: ["order_id", "code"], columns: ["order_id", "code", "share_percent", "amount_minor", "status", "position", "data"] },
  { name: "files", keys: ["file_id"], columns: ["file_id", "owner_id", "purpose", "original_filename", "declared_content_type", "detected_content_type", "size_bytes", "state", "object_key", "created_at", "position", "data"] },
  { name: "file_references", keys: ["file_id", "reference_type", "reference_id", "field"], columns: ["file_id", "reference_type", "reference_id", "field", "position", "data"] },
  { name: "credit_accounts", keys: ["user_id"], columns: ["user_id", "balance_minor", "data"] },
  { name: "credit_ledger", keys: ["id"], columns: ["id", "user_id", "amount_minor", "balance_after_minor", "created_at", "position", "data"] },
  { name: "claims", keys: ["id"], columns: ["id", "order_id", "status", "created_at", "updated_at", "position", "data"] },
  { name: "issues", keys: ["id"], columns: ["id", "order_id", "client_id", "claim_id", "kind", "status", "created_at", "updated_at", "position", "data"] },
  { name: "audit_log", keys: ["id"], columns: ["id", "at", "actor_id", "actor_role", "action", "entity_type", "entity_id", "order_id", "position", "data"] },
  { name: "notifications", keys: ["id"], columns: ["id", "user_id", "type", "order_id", "created_at", "read_at", "deleted_at", "position", "data"] },
  { name: "location_pings", keys: ["id"], columns: ["id", "order_id", "rider_id", "lat", "lng", "accuracy_meters", "at", "position", "data"] },
  { name: "escalations", keys: ["id"], columns: ["id", "order_id", "rider_id", "status", "created_at", "updated_at", "position", "data"] },
  { name: "proofs", keys: ["id"], columns: ["id", "order_id", "uploader_id", "created_at", "position", "data"] },
  { name: "device_tokens", keys: ["id"], columns: ["id", "user_id", "token", "platform", "created_at", "updated_at", "position", "data"] },
];

export function emptyStore() {
  return {
    version: 3,
    users: [],
    catalog: [],
    taxonomy: { categories: [], categoryAliases: [], subcategories: [], materials: [], finishes: [] },
    settings: {},
    zones: [],
    supplierServices: [],
    orders: [],
    files: [],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [],
    locationPings: [],
    escalations: [],
    proofs: [],
    deviceTokens: [],
  };
}

function rowsFromStore(store) {
  const rows = Object.fromEntries(TABLES.map(({ name }) => [name, []]));
  rows.platform_settings.push({ singleton: true, version: store.version || 3, settings: store.settings || {} });

  for (const [position, user] of (store.users || []).entries()) {
    rows.users.push({
      id: user.id,
      clerk_user_id: user.clerkUserId,
      email: user.email,
      name: user.name,
      phone: user.phone ?? null,
      role: user.role,
      account_type: user.role === "client" ? (user.accountType || "individual") : null,
      org_name: user.orgName ?? null,
      verification_status: user.verificationStatus ?? null,
      shop_lat: user.shop?.lat ?? null,
      shop_lng: user.shop?.lng ?? null,
      shop_label: user.shop?.label ?? null,
      created_at: user.createdAt,
      position,
      data: without(user, ["id", "clerkUserId", "email", "name", "phone", "role", "accountType", "orgName", "verificationStatus", "shop", "createdAt"]),
    });
  }
  for (const [position, item] of (store.catalog || []).entries()) {
    rows.catalog_products.push({ id: item.id, name: item.name, family: item.family, base_price_minor: money(item.basePriceMinor, "catalog.basePriceMinor"), unit: item.unit, position, data: without(item, ["id", "name", "family", "basePriceMinor", "unit"]) });
  }
  for (const [position, item] of (store.taxonomy?.categories || []).entries()) {
    rows.taxonomy_categories.push({ id: item.id, code: item.code, name: item.name, active: item.active !== false, sort_order: item.sortOrder ?? position + 1, position, data: without(item, ["id", "code", "name", "active", "sortOrder"]) });
  }
  for (const [position, item] of (store.taxonomy?.categoryAliases || []).entries()) {
    rows.taxonomy_category_aliases.push({ code: item.code, category_code: item.categoryCode, position, data: without(item, ["code", "categoryCode"]) });
  }
  for (const [position, item] of (store.taxonomy?.subcategories || []).entries()) {
    rows.taxonomy_subcategories.push({ id: item.id, code: item.code, category_code: item.categoryCode, name: item.name, active: item.active !== false, sort_order: item.sortOrder ?? position + 1, position, data: without(item, ["id", "code", "categoryCode", "name", "active", "sortOrder"]) });
  }
  for (const [position, item] of (store.taxonomy?.materials || []).entries()) {
    rows.taxonomy_materials.push({ id: item.id, code: item.code, name: item.name, category_codes: item.categoryCodes || [], active: item.active !== false, position, data: without(item, ["id", "code", "name", "categoryCodes", "active"]) });
  }
  for (const [position, item] of (store.taxonomy?.finishes || []).entries()) {
    rows.taxonomy_finishes.push({ id: item.id, code: item.code, name: item.name, category_codes: item.categoryCodes || [], active: item.active !== false, position, data: without(item, ["id", "code", "name", "categoryCodes", "active"]) });
  }
  for (const [position, zone] of (store.zones || []).entries()) {
    rows.zones.push({ id: zone.id, code: zone.code, name: zone.name, active: zone.active !== false, position, data: without(zone, ["id", "code", "name", "active"]) });
  }
  for (const [position, service] of (store.supplierServices || []).entries()) {
    rows.supplier_services.push({
      id: service.id, supplier_id: service.supplierId, category_code: service.categoryCode, state: service.state,
      reference_rate_minor: money(service.referenceRateMinor, "supplierService.referenceRateMinor"),
      turnaround_hours: service.turnaroundHours, created_at: service.createdAt, updated_at: service.updatedAt,
      position, data: without(service, ["id", "supplierId", "categoryCode", "state", "referenceRateMinor", "turnaroundHours", "createdAt", "updatedAt"]),
    });
  }
  for (const [position, order] of (store.orders || []).entries()) {
    rows.orders.push({
      id: order.id, client_id: order.clientId, supplier_id: order.supplierId ?? null, rider_id: order.riderId ?? null,
      product_id: order.productId ?? null, state: order.state, zone_code: order.zone ?? null,
      supplier_price_minor: money(order.supplierPriceMinor, "order.supplierPriceMinor"),
      commission_minor: money(order.commissionMinor, "order.commissionMinor"), subtotal_minor: money(order.subtotalMinor, "order.subtotalMinor"),
      delivery_fee_minor: money(order.deliveryFeeMinor, "order.deliveryFeeMinor"), total_minor: money(order.totalMinor, "order.totalMinor"),
      downpayment_minor: money(order.downpaymentMinor, "order.downpaymentMinor"), balance_minor: money(order.balanceMinor, "order.balanceMinor"),
      payout_hold: Boolean(order.payoutHold), pickup_lat: order.pickup?.lat ?? null, pickup_lng: order.pickup?.lng ?? null,
      pickup_label: order.pickup?.label ?? null, dropoff_lat: order.dropoff?.lat, dropoff_lng: order.dropoff?.lng,
      dropoff_label: order.dropoff?.label, issue_window_opened_at: order.issueWindowOpenedAt ?? null,
      issue_window_expires_at: order.issueWindowExpiresAt ?? null, created_at: order.createdAt, updated_at: order.updatedAt, position,
      data: without(order, ["id", "clientId", "supplierId", "riderId", "productId", "state", "zone", "supplierPriceMinor", "commissionMinor", "subtotalMinor", "deliveryFeeMinor", "totalMinor", "downpaymentMinor", "balanceMinor", "payoutHold", "pickup", "dropoff", "issueWindowOpenedAt", "issueWindowExpiresAt", "createdAt", "updatedAt", "payments", "payoutMilestones"]),
    });
    for (const [paymentPosition, code] of ["downpayment", "balance"].entries()) {
      const payment = order.payments?.[code];
      if (!payment) continue;
      rows.order_payments.push({ order_id: order.id, code, amount_minor: money(payment.amountMinor, `payment.${code}.amountMinor`), method: payment.method, status: payment.status, position: paymentPosition, data: without(payment, ["amountMinor", "method", "status"]) });
    }
    for (const [milestonePosition, milestone] of (order.payoutMilestones || []).entries()) {
      rows.payout_milestones.push({ order_id: order.id, code: milestone.code, share_percent: milestone.sharePercent, amount_minor: money(milestone.amountMinor, "payoutMilestone.amountMinor"), status: milestone.status, position: milestonePosition, data: without(milestone, ["code", "sharePercent", "amountMinor", "status"]) });
    }
  }
  for (const [position, file] of (store.files || []).entries()) {
    rows.files.push({ file_id: file.fileId, owner_id: file.ownerId, purpose: file.purpose, original_filename: file.originalFilename, declared_content_type: file.declaredContentType, detected_content_type: file.detectedContentType ?? null, size_bytes: file.size ?? null, state: file.state, object_key: file.objectKey, created_at: file.createdAt, position, data: without(file, ["fileId", "ownerId", "purpose", "originalFilename", "declaredContentType", "detectedContentType", "size", "state", "objectKey", "createdAt", "references"]) });
    for (const [referencePosition, reference] of (file.references || []).entries()) {
      rows.file_references.push({ file_id: file.fileId, reference_type: reference.type, reference_id: reference.id, field: reference.field, position: referencePosition, data: without(reference, ["type", "id", "field"]) });
    }
  }
  for (const [userId, account] of Object.entries(store.credits || {})) {
    rows.credit_accounts.push({ user_id: userId, balance_minor: money(account.balanceMinor, "credits.balanceMinor"), data: without(account, ["balanceMinor", "ledger"]) });
    for (const [position, entry] of (account.ledger || []).entries()) {
      rows.credit_ledger.push({ id: entry.id, user_id: userId, amount_minor: money(entry.amountMinor, "creditLedger.amountMinor"), balance_after_minor: money(entry.balanceAfterMinor, "creditLedger.balanceAfterMinor"), created_at: entry.at, position, data: without(entry, ["id", "amountMinor", "balanceAfterMinor", "at"]) });
    }
  }
  for (const [position, claim] of (store.claims || []).entries()) rows.claims.push({ id: claim.id, order_id: claim.orderId, status: claim.status, created_at: claim.createdAt, updated_at: claim.updatedAt, position, data: without(claim, ["id", "orderId", "status", "createdAt", "updatedAt"]) });
  for (const [position, issue] of (store.issues || []).entries()) rows.issues.push({ id: issue.id, order_id: issue.orderId, client_id: issue.clientId, claim_id: issue.claimId ?? null, kind: issue.kind, status: issue.status, created_at: issue.createdAt, updated_at: issue.updatedAt, position, data: without(issue, ["id", "orderId", "clientId", "claimId", "kind", "status", "createdAt", "updatedAt"]) });
  for (const [position, entry] of (store.auditLog || []).entries()) rows.audit_log.push({ id: entry.id, at: entry.at, actor_id: entry.actorId ?? null, actor_role: entry.actorRole ?? null, action: entry.action, entity_type: entry.entityType ?? null, entity_id: entry.entityId ?? null, order_id: entry.orderId ?? null, position, data: without(entry, ["id", "at", "actorId", "actorRole", "action", "entityType", "entityId", "orderId"]) });
  for (const [position, item] of (store.notifications || []).entries()) rows.notifications.push({ id: item.id, user_id: item.userId, type: item.type || "general", order_id: item.orderId ?? null, created_at: item.at || item.createdAt, read_at: item.readAt ?? (item.read ? (item.at || item.createdAt) : null), deleted_at: item.deletedAt ?? null, position, data: without(item, ["id", "userId", "type", "orderId", "at", "createdAt", "read", "readAt", "deletedAt"]) });
  for (const [position, ping] of (store.locationPings || []).entries()) rows.location_pings.push({ id: ping.id, order_id: ping.orderId, rider_id: ping.riderId, lat: ping.lat, lng: ping.lng, accuracy_meters: ping.accuracy ?? null, at: ping.at, position, data: without(ping, ["id", "orderId", "riderId", "lat", "lng", "accuracy", "at"]) });
  for (const [position, item] of (store.escalations || []).entries()) rows.escalations.push({ id: item.id, order_id: item.orderId, rider_id: item.riderId ?? null, status: item.status, created_at: item.createdAt, updated_at: item.updatedAt || item.createdAt, position, data: without(item, ["id", "orderId", "riderId", "status", "createdAt", "updatedAt"]) });
  for (const [position, item] of (store.proofs || []).entries()) rows.proofs.push({ id: item.id, order_id: item.orderId, uploader_id: item.uploaderId ?? null, created_at: item.createdAt || item.at, position, data: without(item, ["id", "orderId", "uploaderId", "createdAt", "at"]) });
  for (const [position, item] of (store.deviceTokens || []).entries()) rows.device_tokens.push(deviceTokenRow(item, position));
  return rows;
}

const DEVICE_TOKENS_TABLE = TABLES.find((table) => table.name === "device_tokens");

function deviceTokenRow(item, position) {
  return { id: item.id, user_id: item.userId ?? null, token: item.token, platform: item.platform, created_at: item.createdAt, updated_at: item.updatedAt, position, data: without(item, ["id", "userId", "token", "platform", "createdAt", "updatedAt"]) };
}

function deviceTokenItem(row) {
  return { ...row.data, id: row.id, userId: row.user_id, token: row.token, platform: row.platform, createdAt: row.created_at, updatedAt: row.updated_at };
}

function attachBaseline(store, rows) {
  Object.defineProperty(store, BASELINE, { value: structuredClone(rows), writable: true, enumerable: false });
  return store;
}

function ordered(rows) {
  return [...rows].sort((a, b) => a.position - b.position);
}

export async function loadStore(database) {
  if (!database.inTransaction()) return database.snapshot(() => loadStore(database));
  const loaded = {};
  for (const table of TABLES) {
    loaded[table.name] = (await database.query(`SELECT ${table.columns.join(", ")} FROM ${table.name}`)).rows;
  }
  const store = emptyStore();
  const settings = loaded.platform_settings[0];
  if (settings) { store.version = settings.version; store.settings = settings.settings; }

  store.users = ordered(loaded.users).map((row) => {
    const item = { ...row.data, id: row.id, clerkUserId: row.clerk_user_id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
    present(item, "phone", row.phone); present(item, "accountType", row.account_type); present(item, "orgName", row.org_name); present(item, "verificationStatus", row.verification_status);
    if (row.shop_lat != null) item.shop = { lat: row.shop_lat, lng: row.shop_lng, label: row.shop_label };
    return item;
  });
  store.catalog = ordered(loaded.catalog_products).map((row) => ({ ...row.data, id: row.id, name: row.name, family: row.family, basePriceMinor: row.base_price_minor, unit: row.unit }));
  store.taxonomy.categories = ordered(loaded.taxonomy_categories).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, active: row.active, sortOrder: row.sort_order }));
  store.taxonomy.categoryAliases = ordered(loaded.taxonomy_category_aliases).map((row) => ({ ...row.data, code: row.code, categoryCode: row.category_code }));
  store.taxonomy.subcategories = ordered(loaded.taxonomy_subcategories).map((row) => ({ ...row.data, id: row.id, code: row.code, categoryCode: row.category_code, name: row.name, active: row.active, sortOrder: row.sort_order }));
  store.taxonomy.materials = ordered(loaded.taxonomy_materials).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, categoryCodes: row.category_codes, active: row.active }));
  store.taxonomy.finishes = ordered(loaded.taxonomy_finishes).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, categoryCodes: row.category_codes, active: row.active }));
  store.zones = ordered(loaded.zones).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, active: row.active }));
  store.supplierServices = ordered(loaded.supplier_services).map((row) => ({ ...row.data, id: row.id, supplierId: row.supplier_id, categoryCode: row.category_code, state: row.state, referenceRateMinor: row.reference_rate_minor, turnaroundHours: row.turnaround_hours, createdAt: row.created_at, updatedAt: row.updated_at }));

  const payments = new Map();
  for (const row of ordered(loaded.order_payments)) {
    if (!payments.has(row.order_id)) payments.set(row.order_id, {});
    payments.get(row.order_id)[row.code] = { ...row.data, amountMinor: row.amount_minor, method: row.method, status: row.status };
  }
  const milestones = new Map();
  for (const row of ordered(loaded.payout_milestones)) {
    if (!milestones.has(row.order_id)) milestones.set(row.order_id, []);
    milestones.get(row.order_id).push({ ...row.data, code: row.code, sharePercent: row.share_percent, amountMinor: row.amount_minor, status: row.status });
  }
  store.orders = ordered(loaded.orders).map((row) => {
    const item = { ...row.data, id: row.id, clientId: row.client_id, supplierId: row.supplier_id, riderId: row.rider_id, productId: row.product_id, state: row.state, zone: row.zone_code, supplierPriceMinor: row.supplier_price_minor, commissionMinor: row.commission_minor, subtotalMinor: row.subtotal_minor, deliveryFeeMinor: row.delivery_fee_minor, totalMinor: row.total_minor, downpaymentMinor: row.downpayment_minor, balanceMinor: row.balance_minor, payoutHold: row.payout_hold, pickup: row.pickup_lat == null ? null : { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_label }, dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label }, payments: payments.get(row.id) || {}, payoutMilestones: milestones.get(row.id) || [], createdAt: row.created_at, updatedAt: row.updated_at };
    present(item, "issueWindowOpenedAt", row.issue_window_opened_at);
    present(item, "issueWindowExpiresAt", row.issue_window_expires_at);
    return item;
  });

  const references = new Map();
  for (const row of ordered(loaded.file_references)) {
    if (!references.has(row.file_id)) references.set(row.file_id, []);
    references.get(row.file_id).push({ ...row.data, type: row.reference_type, id: row.reference_id, field: row.field });
  }
  store.files = ordered(loaded.files).map((row) => ({ ...row.data, fileId: row.file_id, ownerId: row.owner_id, purpose: row.purpose, originalFilename: row.original_filename, declaredContentType: row.declared_content_type, detectedContentType: row.detected_content_type, size: row.size_bytes, state: row.state, objectKey: row.object_key, references: references.get(row.file_id) || [], createdAt: row.created_at }));

  const ledger = new Map();
  for (const row of ordered(loaded.credit_ledger)) {
    if (!ledger.has(row.user_id)) ledger.set(row.user_id, []);
    ledger.get(row.user_id).push({ ...row.data, id: row.id, amountMinor: row.amount_minor, balanceAfterMinor: row.balance_after_minor, at: row.created_at });
  }
  for (const row of loaded.credit_accounts) store.credits[row.user_id] = { ...row.data, balanceMinor: row.balance_minor, ledger: ledger.get(row.user_id) || [] };
  store.claims = ordered(loaded.claims).map((row) => ({ ...row.data, id: row.id, orderId: row.order_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  store.issues = ordered(loaded.issues).map((row) => { const item = { ...row.data, id: row.id, orderId: row.order_id, clientId: row.client_id, kind: row.kind, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; present(item, "claimId", row.claim_id); return item; });
  store.auditLog = ordered(loaded.audit_log).map((row) => ({ ...row.data, id: row.id, at: row.at, actorId: row.actor_id, actorRole: row.actor_role, action: row.action, entityType: row.entity_type, entityId: row.entity_id, orderId: row.order_id }));
  store.notifications = ordered(loaded.notifications).map((row) => { const item = { ...row.data, id: row.id, userId: row.user_id, type: row.type, read: row.read_at != null, at: row.created_at }; if (row.order_id != null) item.orderId = row.order_id; if (row.deleted_at != null) item.deletedAt = row.deleted_at; return item; });
  store.locationPings = ordered(loaded.location_pings).map((row) => ({ ...row.data, id: row.id, orderId: row.order_id, riderId: row.rider_id, lat: row.lat, lng: row.lng, accuracy: row.accuracy_meters, at: row.at }));
  store.escalations = ordered(loaded.escalations).map((row) => ({ ...row.data, id: row.id, orderId: row.order_id, riderId: row.rider_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  store.proofs = ordered(loaded.proofs).map((row) => ({ ...row.data, id: row.id, orderId: row.order_id, uploaderId: row.uploader_id, createdAt: row.created_at }));
  store.deviceTokens = ordered(loaded.device_tokens).map(deviceTokenItem);
  return attachBaseline(store, rowsFromStore(store));
}

/**
 * Device-token-only store for routes that must not join the whole-store
 * domain transaction. The returned object works with the push.js device
 * functions and persists exclusively through saveDeviceTokenStore.
 *
 * These routes serialize under their own advisory lock, so this snapshot can
 * go stale against a claim committed under the domain lock. saveDeviceTokenStore
 * therefore guards every write on `user_id IS NULL`: a row claimed after the
 * snapshot was taken is never updated, deleted, or unclaimed by this path.
 */
export async function loadDeviceTokenStore(database) {
  if (!database.inTransaction()) throw new Error("loadDeviceTokenStore requires an active transaction");
  const rows = (await database.query(`SELECT ${DEVICE_TOKENS_TABLE.columns.join(", ")} FROM device_tokens`)).rows;
  const store = { deviceTokens: ordered(rows).map(deviceTokenItem) };
  return attachBaseline(store, { device_tokens: store.deviceTokens.map(deviceTokenRow) });
}

export async function saveDeviceTokenStore(database, store) {
  if (!database.inWriteTransaction()) throw new Error("saveDeviceTokenStore requires an active write transaction");
  const currentRows = (store.deviceTokens || []).map(deviceTokenRow);
  const before = rowMap(store[BASELINE]?.device_tokens || [], DEVICE_TOKENS_TABLE);
  const current = rowMap(currentRows, DEVICE_TOKENS_TABLE);
  const { columns } = DEVICE_TOKENS_TABLE;
  for (const [key, row] of before) {
    if (current.has(key)) continue;
    await database.query("DELETE FROM device_tokens WHERE id = $1 AND user_id IS NULL", [row.id]);
  }
  for (const [key, row] of current) {
    const prior = before.get(key);
    if (prior && stable(prior) === stable(row)) continue;
    if (prior) {
      const fields = columns.filter((column) => column !== "id");
      const updates = fields.map((column, index) => `${column} = $${index + 2}`).join(", ");
      await database.query(
        `UPDATE device_tokens SET ${updates} WHERE id = $1 AND user_id IS NULL`,
        [row.id, ...fields.map((column) => row[column])],
      );
    } else {
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const updates = columns.filter((column) => column !== "token").map((column) => `${column} = EXCLUDED.${column}`).join(", ");
      await database.query(
        `INSERT INTO device_tokens (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (token) DO UPDATE SET ${updates} WHERE device_tokens.user_id IS NULL`,
        columns.map((column) => row[column]),
      );
    }
  }
  store[BASELINE] = { device_tokens: structuredClone(currentRows) };
}

function rowMap(rows, table) {
  return new Map(rows.map((row) => [rowKey(row, table.keys), row]));
}

async function deleteMissing(database, table, before, current) {
  for (const [key, row] of before) {
    if (current.has(key)) continue;
    const where = table.keys.map((column, index) => `${column} = $${index + 1}`).join(" AND ");
    await database.query(`DELETE FROM ${table.name} WHERE ${where}`, table.keys.map((column) => row[column]));
  }
}

async function upsertChanged(database, table, before, current) {
  for (const [key, row] of current) {
    if (before.has(key) && stable(before.get(key)) === stable(row)) continue;
    const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(", ");
    const updates = table.columns.filter((column) => !table.keys.includes(column)).map((column) => `${column} = EXCLUDED.${column}`).join(", ");
    await database.query(
      `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${table.keys.join(", ")}) DO UPDATE SET ${updates}`,
      table.columns.map((column) => row[column]),
    );
  }
}

export async function saveStore(database, store) {
  if (!database.inWriteTransaction()) throw new Error("saveStore requires an active write transaction");
  const currentRows = rowsFromStore(store);
  const baselineRows = store[BASELINE] || Object.fromEntries(TABLES.map(({ name }) => [name, []]));
  const maps = new Map(TABLES.map((table) => [table.name, { before: rowMap(baselineRows[table.name] || [], table), current: rowMap(currentRows[table.name], table) }]));
  for (const table of [...TABLES].reverse()) {
    const { before, current } = maps.get(table.name);
    await deleteMissing(database, table, before, current);
  }
  for (const table of TABLES) {
    const { before, current } = maps.get(table.name);
    await upsertChanged(database, table, before, current);
  }
  if (Object.hasOwn(store, BASELINE)) {
    store[BASELINE] = structuredClone(currentRows);
  } else {
    attachBaseline(store, currentRows);
  }
}

export function originalNotificationIds(store) {
  return new Set((store[BASELINE]?.notifications || []).map((row) => row.id));
}
