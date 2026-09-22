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
  { name: "users", keys: ["id"], columns: ["id", "clerk_user_id", "email", "name", "phone", "role", "account_type", "org_name", "verification_status", "shop_lat", "shop_lng", "shop_label", "version", "created_at", "position", "data"] },
  { name: "user_role_memberships", keys: ["user_id", "role"], columns: ["user_id", "role", "created_at", "created_by"] },
  { name: "client_profiles", keys: ["user_id"], columns: ["user_id", "client_kind", "business_name", "business_nature", "updated_at"] },
  { name: "client_match_preferences", keys: ["client_id"], columns: ["client_id", "ranking", "version", "updated_at"] },
  { name: "client_saved_addresses", keys: ["id"], columns: ["id", "client_id", "label", "address_line", "lat", "lng", "is_default", "version", "created_at", "updated_at"] },
  { name: "supplier_profiles", keys: ["user_id"], columns: ["user_id", "shop_name", "contact_name", "shop_lat", "shop_lng", "shop_label", "pickup_available", "is_closed", "schedule", "version", "updated_at"] },
  { name: "shop_reviews", keys: ["id"], columns: ["id", "order_id", "supplier_id", "client_id", "quality_stars", "speed_stars", "value_stars", "comment", "created_at"] },
  { name: "supplier_payment_terms", keys: ["supplier_id"], columns: ["supplier_id", "delivery_downpayment_rate_bps", "pickup_full_online_enabled", "pickup_downpayment_store_enabled", "pickup_downpayment_rate_bps", "version", "updated_at"] },
  { name: "rider_profiles", keys: ["user_id"], columns: ["user_id", "vehicle_type", "plate_number", "license_number", "version", "updated_at"] },
  { name: "approval_cases", keys: ["id"], columns: ["id", "user_id", "kind", "status", "version", "application_revision", "submitted_at", "decided_at", "decided_by", "rejection_reason", "suspension_reason", "created_at", "updated_at"] },
  { name: "approval_case_events", keys: ["id"], columns: ["id", "approval_case_id", "application_revision", "from_status", "to_status", "actor_user_id", "actor_kind", "reason", "request_id", "snapshot", "created_at"], appendOnly: true },
  { name: "catalog_products", keys: ["id"], columns: ["id", "name", "family", "base_price_minor", "unit", "position", "data"] },
  { name: "taxonomy_categories", keys: ["id"], columns: ["id", "code", "name", "active", "sort_order", "position", "data"] },
  { name: "taxonomy_category_aliases", keys: ["code"], columns: ["code", "category_code", "position", "data"] },
  { name: "taxonomy_subcategories", keys: ["id"], columns: ["id", "code", "category_code", "name", "active", "sort_order", "position", "data"] },
  { name: "taxonomy_materials", keys: ["id"], columns: ["id", "code", "name", "category_codes", "active", "position", "data"] },
  { name: "taxonomy_finishes", keys: ["id"], columns: ["id", "code", "name", "category_codes", "active", "position", "data"] },
  { name: "zones", keys: ["id"], columns: ["id", "code", "name", "active", "position", "data"] },
  { name: "supplier_services", keys: ["id"], columns: ["id", "supplier_id", "category_code", "state", "reference_rate_minor", "turnaround_hours", "pricing_basis", "standard_turnaround_hours", "rush_enabled", "rush_turnaround_hours", "rush_price_minor", "version", "created_at", "updated_at", "position", "data"] },
  { name: "supplier_service_price_tiers", keys: ["id"], columns: ["id", "supplier_service_id", "tier_code", "color_tier", "min_quantity", "max_quantity", "unit_price_minor", "sort_order"] },
  { name: "accepted_file_formats", keys: ["code"], columns: ["code", "display_name", "input_kind", "extensions", "mime_types", "active"] },
  { name: "supplier_service_file_formats", keys: ["supplier_service_id", "format_code"], columns: ["supplier_service_id", "format_code"] },
  { name: "supplier_catalog_items", keys: ["id"], columns: ["id", "supplier_id", "supplier_service_id", "subcategory_code", "name", "description", "base_price_minor", "pricing_unit", "package_qty", "measure_unit", "minimum_width_milli", "minimum_height_milli", "minimum_length_milli", "minimum_order_quantity", "printer_max_width_feet", "turnaround_mode", "turnaround_hours", "minimum_turnaround_hours", "file_format_mode", "active", "sort_order", "version", "created_at", "updated_at"] },
  { name: "supplier_catalog_option_groups", keys: ["id"], columns: ["id", "catalog_item_id", "name", "kind", "help_text", "required", "selection_mode", "sort_order", "version", "created_at", "updated_at"] },
  { name: "supplier_catalog_options", keys: ["id"], columns: ["id", "option_group_id", "label", "price_modifier_minor", "price_multiplier_bps", "spec_binding", "active", "sort_order", "created_at", "updated_at"] },
  { name: "supplier_catalog_price_tiers", keys: ["id"], columns: ["id", "catalog_item_id", "min_quantity", "unit_price_minor", "created_at", "updated_at"] },
  { name: "supplier_catalog_speed_tiers", keys: ["id"], columns: ["id", "catalog_item_id", "label", "turnaround_hours", "price_minor", "surcharge_minor", "sort_order", "created_at", "updated_at"] },
  { name: "supplier_catalog_item_file_formats", keys: ["catalog_item_id", "format_code"], columns: ["catalog_item_id", "format_code"] },
  { name: "supplier_catalog_prep_steps", keys: ["id"], columns: ["id", "catalog_item_id", "sort_order", "title", "body", "created_at", "updated_at"] },
  { name: "listing_starters", keys: ["id"], columns: ["id", "subcategory_code", "name", "default_pricing_unit", "default_package_qty", "default_turnaround_hours", "default_format_codes"] },
  { name: "listing_starter_groups", keys: ["id"], columns: ["id", "starter_id", "name", "kind", "help_text", "required", "sort_order"] },
  { name: "listing_starter_options", keys: ["id"], columns: ["id", "starter_group_id", "label", "price_modifier_minor", "price_multiplier_bps", "spec_binding", "sort_order"] },
  { name: "files", keys: ["file_id"], columns: ["file_id", "owner_id", "purpose", "original_filename", "declared_content_type", "detected_content_type", "size_bytes", "state", "object_key", "created_at", "position", "data"] },
  { name: "orders", keys: ["id"], columns: ["id", "client_id", "supplier_id", "rider_id", "product_id", "state", "zone_code", "supplier_subtotal_minor", "subtotal_minor", "service_fee_rate_bps", "service_fee_minor", "delivery_fee_minor", "total_minor", "fulfillment_mode", "payment_plan", "quote_version", "supplier_downpayment_rate_bps", "online_due_minor", "direct_store_due_minor", "supplier_platform_payout_minor", "commercial_committed_at", "money_model_version", "payout_hold", "pickup_lat", "pickup_lng", "pickup_label", "dropoff_lat", "dropoff_lng", "dropoff_label", "issue_window_opened_at", "issue_window_expires_at", "ready_by", "ready_at", "cancelled_at", "cancelled_by", "cancellation_reason", "created_at", "updated_at", "position", "data"] },
  { name: "client_carts", keys: ["id"], columns: ["id", "client_id", "state", "version", "service_level", "scheduled_for", "fulfillment_mode", "default_dropoff_lat", "default_dropoff_lng", "default_dropoff_label", "checked_out_order_id", "created_at", "updated_at", "checked_out_at"] },
  { name: "client_cart_lines", keys: ["id"], columns: ["id", "cart_id", "supplier_id", "catalog_item_id", "option_ids", "quantity", "structured_spec", "artwork_file_id", "mockup_file_id", "dropoff_lat", "dropoff_lng", "dropoff_label", "measure_pages", "measure_width_milli", "measure_height_milli", "measure_length_milli", "sort_order", "created_at", "updated_at"] },
  { name: "order_jobs", keys: ["id"], columns: ["id", "order_id", "supplier_id", "rider_id", "state", "fulfillment_mode", "pickup_lat", "pickup_lng", "pickup_label", "dropoff_lat", "dropoff_lng", "dropoff_label", "supplier_subtotal_minor", "delivery_distance_meters", "delivery_fee_minor", "estimated_hours", "scheduled_for", "created_at", "updated_at"] },
  { name: "order_line_items", keys: ["id"], columns: ["id", "order_id", "job_id", "source_catalog_item_id", "source_supplier_service_id", "item_name_snapshot", "description_snapshot", "pricing_basis_snapshot", "pricing_unit_snapshot", "package_qty_snapshot", "turnaround_hours_snapshot", "base_unit_price_minor", "effective_unit_price_minor", "quantity", "line_subtotal_minor", "accepted_format_codes_snapshot", "structured_spec_snapshot", "artwork_file_id", "mockup_file_id", "dropoff_lat", "dropoff_lng", "dropoff_label", "measure_pages", "measure_width_milli", "measure_height_milli", "measure_length_milli", "sort_order", "snapshot_finalized", "created_at"] },
  { name: "order_line_item_options", keys: ["id"], columns: ["id", "order_line_item_id", "source_option_group_id", "source_option_id", "group_name_snapshot", "group_kind_snapshot", "option_label_snapshot", "price_modifier_minor", "sort_order"] },
  { name: "order_invoices", keys: ["order_id"], columns: ["order_id", "invoice_number", "issued_at", "snapshot"] },
  { name: "order_payments", keys: ["order_id", "code"], columns: ["order_id", "code", "amount_minor", "method", "status", "position", "data"] },
  { name: "order_payment_allocations", keys: ["order_id", "payment_code", "component"], columns: ["order_id", "payment_code", "component", "amount_minor"] },
  { name: "platform_revenue_adjustments", keys: ["id"], columns: ["id", "order_id", "kind", "amount_minor", "reason", "created_by", "created_at"], appendOnly: true },
  { name: "payout_milestones", keys: ["order_id", "code"], columns: ["order_id", "code", "share_percent", "amount_minor", "status", "position", "data"] },
  { name: "supplier_catalog_item_photos", keys: ["catalog_item_id", "file_id"], columns: ["catalog_item_id", "file_id", "sort_order", "alt_text", "created_at"] },
  { name: "supplier_shop_media", keys: ["supplier_id", "slot"], columns: ["supplier_id", "slot", "file_id", "updated_at"] },
  { name: "supplier_payout_accounts", keys: ["supplier_id"], columns: ["supplier_id", "provider", "account_name", "account_number", "institution", "qr_file_id", "version", "updated_at"] },
  { name: "file_references", keys: ["file_id", "reference_type", "reference_id", "field"], columns: ["file_id", "reference_type", "reference_id", "field", "position", "data"] },
  { name: "rider_documents", keys: ["id"], columns: ["id", "rider_id", "kind", "file_id", "expires_on", "is_current", "uploaded_at", "replaced_at"] },
  { name: "credit_accounts", keys: ["user_id"], columns: ["user_id", "balance_minor", "data"] },
  { name: "credit_ledger", keys: ["id"], columns: ["id", "user_id", "amount_minor", "balance_after_minor", "created_at", "position", "data"] },
  { name: "claims", keys: ["id"], columns: ["id", "order_id", "status", "created_at", "updated_at", "position", "data"] },
  { name: "issues", keys: ["id"], columns: ["id", "order_id", "client_id", "claim_id", "kind", "status", "created_at", "updated_at", "position", "data"] },
  { name: "audit_log", keys: ["id"], columns: ["id", "at", "actor_id", "actor_role", "action", "entity_type", "entity_id", "order_id", "position", "data"] },
  { name: "notifications", keys: ["id"], columns: ["id", "user_id", "type", "order_id", "created_at", "read_at", "deleted_at", "position", "data"] },
  { name: "location_pings", keys: ["id"], columns: ["id", "order_id", "rider_id", "lat", "lng", "accuracy_meters", "at", "position", "data"] },
  { name: "escalations", keys: ["id"], columns: ["id", "order_id", "rider_id", "status", "created_at", "updated_at", "position", "data"] },
  { name: "device_tokens", keys: ["id"], columns: ["id", "user_id", "token", "platform", "created_at", "updated_at", "position", "data"] },
];

export function emptyStore() {
  return {
    version: 3,
    users: [],
    userRoleMemberships: [],
    clientProfiles: [],
    clientPreferences: [],
    clientAddresses: [],
    supplierProfiles: [],
    supplierPaymentTerms: [],
    riderProfiles: [],
    approvalCases: [],
    approvalCaseEvents: [],
    catalog: [],
    taxonomy: { categories: [], categoryAliases: [], subcategories: [], materials: [], finishes: [] },
    settings: {},
    zones: [],
    supplierServices: [],
    supplierServicePriceTiers: [],
    acceptedFileFormats: [],
    supplierServiceFileFormats: [],
    catalogItems: [],
    catalogItemPhotos: [],
    supplierShopMedia: [],
    supplierPayoutAccounts: [],
    catalogOptionGroups: [],
    catalogOptions: [],
    catalogItemFileFormats: [],
    catalogPrepSteps: [],
    listingStarters: [],
    listingStarterGroups: [],
    listingStarterOptions: [],
    carts: [],
    cartLines: [],
    orders: [],
    orderJobs: [],
    shopReviews: [],
    catalogPriceTiers: [],
    catalogSpeedTiers: [],
    orderLineItems: [],
    orderLineItemOptions: [],
    orderInvoices: [],
    files: [],
    riderDocuments: [],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [],
    locationPings: [],
    escalations: [],
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
      version: user.version || 1,
      created_at: user.createdAt,
      position,
      data: without(user, ["id", "clerkUserId", "email", "name", "phone", "role", "accountType", "orgName", "verificationStatus", "shop", "version", "createdAt"]),
    });
  }
  for (const membership of (store.userRoleMemberships || [])) {
    rows.user_role_memberships.push({ user_id: membership.userId, role: membership.role, created_at: membership.createdAt, created_by: membership.createdBy ?? null });
  }
  for (const profile of (store.clientProfiles || [])) {
    rows.client_profiles.push({ user_id: profile.userId, client_kind: profile.clientKind, business_name: profile.businessName ?? null, business_nature: profile.businessNature ?? null, updated_at: profile.updatedAt });
  }
  for (const preference of (store.clientPreferences || [])) {
    rows.client_match_preferences.push({
      client_id: preference.userId,
      ranking: preference.ranking,
      version: preference.version || 1,
      updated_at: preference.updatedAt,
    });
  }
  for (const address of (store.clientAddresses || [])) {
    rows.client_saved_addresses.push({
      id: address.id,
      client_id: address.clientId,
      label: address.label,
      address_line: address.addressLine,
      lat: address.point?.lat,
      lng: address.point?.lng,
      is_default: Boolean(address.isDefault),
      version: address.version || 1,
      created_at: address.createdAt,
      updated_at: address.updatedAt,
    });
  }
  for (const profile of (store.supplierProfiles || [])) {
    rows.supplier_profiles.push({ user_id: profile.userId, shop_name: profile.shopName, contact_name: profile.contactName, shop_lat: profile.shop.lat, shop_lng: profile.shop.lng, shop_label: profile.shop.label, pickup_available: Boolean(profile.pickupAvailable), is_closed: Boolean(profile.isClosed), schedule: profile.schedule ?? null, version: profile.version || 1, updated_at: profile.updatedAt });
  }
  for (const review of (store.shopReviews || [])) {
    rows.shop_reviews.push({
      id: review.id,
      order_id: review.orderId,
      supplier_id: review.supplierId,
      client_id: review.clientId,
      quality_stars: review.qualityStars,
      speed_stars: review.speedStars,
      value_stars: review.valueStars,
      comment: review.comment ?? null,
      created_at: review.createdAt,
    });
  }
  for (const terms of (store.supplierPaymentTerms || [])) {
    rows.supplier_payment_terms.push({
      supplier_id: terms.supplierId,
      delivery_downpayment_rate_bps: terms.deliveryDownpaymentRateBps,
      pickup_full_online_enabled: terms.pickupFullOnlineEnabled,
      pickup_downpayment_store_enabled: terms.pickupDownpaymentStoreEnabled,
      pickup_downpayment_rate_bps: terms.pickupDownpaymentRateBps ?? null,
      version: terms.version || 1,
      updated_at: terms.updatedAt,
    });
  }
  const suppliersWithTerms = new Set(rows.supplier_payment_terms.map((terms) => terms.supplier_id));
  for (const profile of (store.supplierProfiles || [])) {
    if (suppliersWithTerms.has(profile.userId)) continue;
    rows.supplier_payment_terms.push({
      supplier_id: profile.userId,
      delivery_downpayment_rate_bps: 0,
      pickup_full_online_enabled: true,
      pickup_downpayment_store_enabled: false,
      pickup_downpayment_rate_bps: null,
      version: 1,
      updated_at: profile.updatedAt,
    });
  }
  for (const profile of (store.riderProfiles || [])) {
    rows.rider_profiles.push({ user_id: profile.userId, vehicle_type: profile.vehicleType, plate_number: profile.plateNumber, license_number: profile.licenseNumber ?? null, version: profile.version || 1, updated_at: profile.updatedAt });
  }
  for (const approvalCase of (store.approvalCases || [])) {
    rows.approval_cases.push({
      id: approvalCase.id, user_id: approvalCase.userId, kind: approvalCase.kind, status: approvalCase.status,
      version: approvalCase.version, application_revision: approvalCase.applicationRevision,
      submitted_at: approvalCase.submittedAt ?? null, decided_at: approvalCase.decidedAt ?? null,
      decided_by: approvalCase.decidedBy ?? null, rejection_reason: approvalCase.rejectionReason ?? null,
      suspension_reason: approvalCase.suspensionReason ?? null, created_at: approvalCase.createdAt,
      updated_at: approvalCase.updatedAt,
    });
  }
  for (const event of (store.approvalCaseEvents || [])) {
    rows.approval_case_events.push({
      id: event.id, approval_case_id: event.approvalCaseId, application_revision: event.applicationRevision,
      from_status: event.fromStatus ?? null, to_status: event.toStatus, actor_user_id: event.actorUserId ?? null,
      actor_kind: event.actorKind, reason: event.reason ?? null, request_id: event.requestId,
      snapshot: event.snapshot || {}, created_at: event.createdAt,
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
      turnaround_hours: service.turnaroundHours,
      pricing_basis: String(service.pricingBasis || "").trim() || null,
      standard_turnaround_hours: Object.hasOwn(service, "standardTurnaroundHours")
        ? service.standardTurnaroundHours
        : null,
      rush_enabled: Boolean(service.rushEnabled),
      rush_turnaround_hours: service.rushEnabled ? service.rushTurnaroundHours : null,
      rush_price_minor: service.rushEnabled ? money(service.rushPriceMinor, "supplierService.rushPriceMinor") : null,
      version: service.version || 1,
      created_at: service.createdAt, updated_at: service.updatedAt,
      position, data: without(service, ["id", "supplierId", "categoryCode", "state", "referenceRateMinor", "turnaroundHours", "pricingBasis", "standardTurnaroundHours", "rushEnabled", "rushTurnaroundHours", "rushPriceMinor", "version", "createdAt", "updatedAt"]),
    });
  }
  for (const tier of (store.supplierServicePriceTiers || [])) {
    rows.supplier_service_price_tiers.push({
      id: tier.id, supplier_service_id: tier.supplierServiceId, tier_code: tier.tierCode,
      color_tier: tier.colorTier ?? null, min_quantity: tier.minQuantity ?? 1,
      max_quantity: tier.maxQuantity ?? null, unit_price_minor: money(tier.unitPriceMinor, "supplierServicePriceTier.unitPriceMinor"),
      sort_order: tier.sortOrder,
    });
  }
  for (const format of (store.acceptedFileFormats || [])) {
    rows.accepted_file_formats.push({
      code: format.code, display_name: format.displayName, input_kind: format.inputKind,
      extensions: format.extensions || [], mime_types: format.mimeTypes || [], active: format.active !== false,
    });
  }
  for (const format of (store.supplierServiceFileFormats || [])) {
    rows.supplier_service_file_formats.push({ supplier_service_id: format.supplierServiceId, format_code: format.formatCode });
  }
  for (const item of (store.catalogItems || [])) {
    rows.supplier_catalog_items.push({
      id: item.id, supplier_id: item.supplierId, supplier_service_id: item.supplierServiceId,
      subcategory_code: item.subcategoryCode, name: item.name, description: item.description || "",
      base_price_minor: money(item.basePriceMinor, "catalogItem.basePriceMinor"),
      pricing_unit: item.pricingUnit || "per_unit", package_qty: item.packageQty ?? null,
      measure_unit: item.measureUnit ?? null,
      minimum_width_milli: item.minimumWidthMilli ?? null,
      minimum_height_milli: item.minimumHeightMilli ?? null,
      minimum_length_milli: item.minimumLengthMilli ?? null,
      minimum_order_quantity: item.minimumOrderQuantity ?? null,
      printer_max_width_feet: item.printerMaxWidthFeet ?? null,
      turnaround_mode: item.turnaroundMode || "inherit", turnaround_hours: item.turnaroundHours ?? null,
      minimum_turnaround_hours: item.minimumTurnaroundHours ?? null,
      file_format_mode: item.fileFormatMode || "inherit", active: item.active !== false,
      sort_order: item.sortOrder, version: item.version || 1,
      created_at: item.createdAt, updated_at: item.updatedAt,
    });
  }
  for (const group of (store.catalogOptionGroups || [])) {
    rows.supplier_catalog_option_groups.push({
      id: group.id, catalog_item_id: group.catalogItemId, name: group.name,
      kind: group.kind || "spec", help_text: group.helpText ?? null,
      required: group.required !== false, selection_mode: "single", sort_order: group.sortOrder,
      version: group.version || 1, created_at: group.createdAt, updated_at: group.updatedAt,
    });
  }
  for (const option of (store.catalogOptions || [])) {
    rows.supplier_catalog_options.push({
      id: option.id, option_group_id: option.optionGroupId, label: option.label,
      price_modifier_minor: money(option.priceModifierMinor ?? 0, "catalogOption.priceModifierMinor"),
      price_multiplier_bps: option.priceMultiplierBps ?? null,
      spec_binding: option.specBinding ?? null, active: option.active !== false,
      sort_order: option.sortOrder, created_at: option.createdAt, updated_at: option.updatedAt,
    });
  }
  for (const tier of (store.catalogPriceTiers || [])) {
    rows.supplier_catalog_price_tiers.push({
      id: tier.id, catalog_item_id: tier.catalogItemId, min_quantity: tier.minQuantity,
      unit_price_minor: money(tier.unitPriceMinor, "catalogPriceTier.unitPriceMinor"),
      created_at: tier.createdAt, updated_at: tier.updatedAt,
    });
  }
  for (const tier of (store.catalogSpeedTiers || [])) {
    rows.supplier_catalog_speed_tiers.push({
      id: tier.id, catalog_item_id: tier.catalogItemId, label: tier.label,
      turnaround_hours: tier.turnaroundHours,
      price_minor: tier.priceMinor == null ? null : money(tier.priceMinor, "catalogSpeedTier.priceMinor"),
      surcharge_minor: tier.surchargeMinor == null ? null : money(tier.surchargeMinor, "catalogSpeedTier.surchargeMinor"),
      sort_order: tier.sortOrder, created_at: tier.createdAt, updated_at: tier.updatedAt,
    });
  }
  for (const format of (store.catalogItemFileFormats || [])) {
    rows.supplier_catalog_item_file_formats.push({ catalog_item_id: format.catalogItemId, format_code: format.formatCode });
  }
  for (const step of (store.catalogPrepSteps || [])) {
    rows.supplier_catalog_prep_steps.push({
      id: step.id, catalog_item_id: step.catalogItemId, sort_order: step.sortOrder,
      title: step.title, body: step.body || "", created_at: step.createdAt, updated_at: step.updatedAt,
    });
  }
  for (const starter of (store.listingStarters || [])) {
    rows.listing_starters.push({
      id: starter.id, subcategory_code: starter.subcategoryCode, name: starter.name,
      default_pricing_unit: starter.defaultPricingUnit || "per_unit",
      default_package_qty: starter.defaultPackageQty ?? null,
      default_turnaround_hours: starter.defaultTurnaroundHours ?? null,
      default_format_codes: starter.defaultFormatCodes || [],
    });
  }
  for (const group of (store.listingStarterGroups || [])) {
    rows.listing_starter_groups.push({
      id: group.id, starter_id: group.starterId, name: group.name, kind: group.kind || "spec",
      help_text: group.helpText ?? null, required: group.required !== false, sort_order: group.sortOrder,
    });
  }
  for (const option of (store.listingStarterOptions || [])) {
    rows.listing_starter_options.push({
      id: option.id, starter_group_id: option.starterGroupId, label: option.label,
      price_modifier_minor: money(option.priceModifierMinor ?? 0, "listingStarterOption.priceModifierMinor"),
      price_multiplier_bps: option.priceMultiplierBps ?? null,
      spec_binding: option.specBinding ?? null, sort_order: option.sortOrder,
    });
  }
  for (const [position, order] of (store.orders || []).entries()) {
    rows.orders.push({
      id: order.id, client_id: order.clientId, supplier_id: order.supplierId ?? null, rider_id: order.riderId ?? null,
      product_id: order.productId ?? null, state: order.state, zone_code: order.zone ?? null,
      supplier_subtotal_minor: money(order.supplierSubtotalMinor, "order.supplierSubtotalMinor"),
      subtotal_minor: money(order.subtotalMinor, "order.subtotalMinor"),
      service_fee_rate_bps: order.serviceFeeRateBps ?? null,
      service_fee_minor: money(order.serviceFeeMinor, "order.serviceFeeMinor"),
      delivery_fee_minor: money(order.deliveryFeeMinor, "order.deliveryFeeMinor"), total_minor: money(order.totalMinor, "order.totalMinor"),
      fulfillment_mode: order.fulfillmentMode ?? null, payment_plan: order.paymentPlan ?? null,
      quote_version: order.quoteVersion ?? null, supplier_downpayment_rate_bps: order.supplierDownpaymentRateBps ?? null,
      online_due_minor: money(order.onlineDueMinor, "order.onlineDueMinor"), direct_store_due_minor: money(order.directStoreDueMinor, "order.directStoreDueMinor"),
      supplier_platform_payout_minor: money(order.supplierPlatformPayoutMinor, "order.supplierPlatformPayoutMinor"),
      commercial_committed_at: order.commercialCommittedAt ?? null, money_model_version: order.moneyModelVersion ?? 1,
      payout_hold: Boolean(order.payoutHold), pickup_lat: order.pickup?.lat ?? null, pickup_lng: order.pickup?.lng ?? null,
      pickup_label: order.pickup?.label ?? null, dropoff_lat: order.dropoff?.lat ?? null, dropoff_lng: order.dropoff?.lng ?? null,
      dropoff_label: order.dropoff?.label ?? null, issue_window_opened_at: order.issueWindowOpenedAt ?? null,
      issue_window_expires_at: order.issueWindowExpiresAt ?? null,
      // The shop's own promised date and when it actually finished: the pair an
      // on-time record is computed from, and what the Operations schedule sorts
      // on. The client's padded date stays in `data` -- nothing queries it.
      ready_by: order.readyBy ?? null, ready_at: order.readyAt ?? null,
      cancelled_at: order.cancelledAt ?? null, cancelled_by: order.cancelledBy ?? null,
      cancellation_reason: order.cancellationReason ?? null,
      created_at: order.createdAt, updated_at: order.updatedAt, position,
      data: without(order, ["readyBy", "readyAt", "cancelledAt", "cancelledBy", "cancellationReason", "id", "clientId", "supplierId", "riderId", "productId", "state", "zone", "supplierSubtotalMinor", "subtotalMinor", "serviceFeeRateBps", "serviceFeeMinor", "deliveryFeeMinor", "totalMinor", "fulfillmentMode", "paymentPlan", "quoteVersion", "supplierDownpaymentRateBps", "onlineDueMinor", "directStoreDueMinor", "supplierPlatformPayoutMinor", "commercialCommittedAt", "moneyModelVersion", "payoutHold", "pickup", "dropoff", "issueWindowOpenedAt", "issueWindowExpiresAt", "createdAt", "updatedAt", "payments", "paymentAllocations", "revenueAdjustments", "payoutMilestones"]),
    });
    for (const [paymentPosition, code] of ["initial", "final_online"].entries()) {
      const payment = order.payments?.[code];
      if (!payment) continue;
      rows.order_payments.push({ order_id: order.id, code, amount_minor: money(payment.amountMinor, `payment.${code}.amountMinor`), method: payment.method, status: payment.status, position: paymentPosition, data: without(payment, ["amountMinor", "method", "status"]) });
    }
    for (const allocation of (order.paymentAllocations || [])) {
      rows.order_payment_allocations.push({
        order_id: order.id,
        payment_code: allocation.paymentCode,
        component: allocation.component,
        amount_minor: money(allocation.amountMinor, "paymentAllocation.amountMinor"),
      });
    }
    for (const adjustment of (order.revenueAdjustments || [])) {
      rows.platform_revenue_adjustments.push({
        id: adjustment.id,
        order_id: order.id,
        kind: adjustment.kind,
        amount_minor: money(adjustment.amountMinor, "revenueAdjustment.amountMinor"),
        reason: adjustment.reason,
        created_by: adjustment.createdBy ?? null,
        created_at: adjustment.createdAt,
      });
    }
    for (const [milestonePosition, milestone] of (order.payoutMilestones || []).entries()) {
      rows.payout_milestones.push({ order_id: order.id, code: milestone.code, share_percent: milestone.sharePercent, amount_minor: money(milestone.amountMinor, "payoutMilestone.amountMinor"), status: milestone.status, position: milestonePosition, data: without(milestone, ["code", "sharePercent", "amountMinor", "status"]) });
    }
  }
  for (const cart of (store.carts || [])) {
    rows.client_carts.push({
      id: cart.id,
      client_id: cart.clientId,
      state: cart.state || "draft",
      version: cart.version || 1,
      service_level: cart.serviceLevel || "standard",
      scheduled_for: cart.scheduledFor ?? null,
      fulfillment_mode: cart.fulfillmentMode || "delivery",
      default_dropoff_lat: cart.defaultDropoff?.lat ?? null,
      default_dropoff_lng: cart.defaultDropoff?.lng ?? null,
      default_dropoff_label: cart.defaultDropoff?.label ?? null,
      checked_out_order_id: cart.checkedOutOrderId ?? null,
      created_at: cart.createdAt,
      updated_at: cart.updatedAt,
      checked_out_at: cart.checkedOutAt ?? null,
    });
  }
  for (const line of (store.cartLines || [])) {
    rows.client_cart_lines.push({
      id: line.id,
      cart_id: line.cartId,
      supplier_id: line.supplierId,
      catalog_item_id: line.catalogItemId,
      option_ids: line.optionIds || [],
      quantity: line.quantity,
      structured_spec: line.structuredSpec || {},
      artwork_file_id: line.artworkFileId ?? null,
      mockup_file_id: line.mockupFileId ?? null,
      dropoff_lat: line.dropoff?.lat ?? null,
      dropoff_lng: line.dropoff?.lng ?? null,
      dropoff_label: line.dropoff?.label ?? null,
      ...measurementColumns(line.measurement),
      sort_order: line.sortOrder,
      created_at: line.createdAt,
      updated_at: line.updatedAt,
    });
  }
  for (const job of (store.orderJobs || [])) {
    rows.order_jobs.push({
      id: job.id,
      order_id: job.orderId,
      supplier_id: job.supplierId,
      rider_id: job.riderId ?? null,
      state: job.state,
      fulfillment_mode: job.fulfillmentMode,
      pickup_lat: job.pickup?.lat,
      pickup_lng: job.pickup?.lng,
      pickup_label: job.pickup?.label,
      dropoff_lat: job.dropoff?.lat ?? null,
      dropoff_lng: job.dropoff?.lng ?? null,
      dropoff_label: job.dropoff?.label ?? null,
      supplier_subtotal_minor: money(job.supplierSubtotalMinor, "orderJob.supplierSubtotalMinor"),
      delivery_distance_meters: job.deliveryDistanceMeters ?? 0,
      delivery_fee_minor: money(job.deliveryFeeMinor, "orderJob.deliveryFeeMinor"),
      estimated_hours: job.estimatedHours,
      scheduled_for: job.scheduledFor ?? null,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    });
  }
  for (const invoice of (store.orderInvoices || [])) {
    rows.order_invoices.push({
      order_id: invoice.orderId,
      invoice_number: invoice.invoiceNumber,
      issued_at: invoice.issuedAt,
      snapshot: invoice.snapshot,
    });
  }
  for (const line of (store.orderLineItems || [])) {
    rows.order_line_items.push({
      id: line.id, order_id: line.orderId, job_id: line.jobId ?? null,
      source_catalog_item_id: line.sourceCatalogItemId ?? null,
      source_supplier_service_id: line.sourceSupplierServiceId ?? null,
      item_name_snapshot: line.itemNameSnapshot, description_snapshot: line.descriptionSnapshot || "",
      pricing_basis_snapshot: line.pricingBasisSnapshot,
      pricing_unit_snapshot: line.pricingUnitSnapshot || "per_unit",
      package_qty_snapshot: line.packageQtySnapshot ?? null,
      turnaround_hours_snapshot: line.turnaroundHoursSnapshot ?? null,
      base_unit_price_minor: money(line.baseUnitPriceMinor, "orderLine.baseUnitPriceMinor"),
      effective_unit_price_minor: money(line.effectiveUnitPriceMinor, "orderLine.effectiveUnitPriceMinor"),
      quantity: line.quantity, line_subtotal_minor: money(line.lineSubtotalMinor, "orderLine.lineSubtotalMinor"),
      accepted_format_codes_snapshot: line.acceptedFormatCodesSnapshot || [],
      structured_spec_snapshot: line.structuredSpecSnapshot || {},
      artwork_file_id: line.artworkFileId ?? null,
      mockup_file_id: line.mockupFileId ?? null,
      dropoff_lat: line.dropoff?.lat ?? null,
      dropoff_lng: line.dropoff?.lng ?? null,
      dropoff_label: line.dropoff?.label ?? null,
      ...measurementColumns(line.measurement),
      sort_order: line.sortOrder, snapshot_finalized: line.snapshotFinalized !== false, created_at: line.createdAt,
    });
  }
  for (const option of (store.orderLineItemOptions || [])) {
    rows.order_line_item_options.push({
      id: option.id, order_line_item_id: option.orderLineItemId,
      source_option_group_id: option.sourceOptionGroupId ?? null,
      source_option_id: option.sourceOptionId ?? null,
      group_name_snapshot: option.groupNameSnapshot,
      group_kind_snapshot: option.groupKindSnapshot || "spec",
      option_label_snapshot: option.optionLabelSnapshot,
      price_modifier_minor: money(option.priceModifierMinor, "orderLineOption.priceModifierMinor"),
      sort_order: option.sortOrder,
    });
  }
  for (const [position, file] of (store.files || []).entries()) {
    rows.files.push({ file_id: file.fileId, owner_id: file.ownerId, purpose: file.purpose, original_filename: file.originalFilename, declared_content_type: file.declaredContentType, detected_content_type: file.detectedContentType ?? null, size_bytes: file.size ?? null, state: file.state, object_key: file.objectKey, created_at: file.createdAt, position, data: without(file, ["fileId", "ownerId", "purpose", "originalFilename", "declaredContentType", "detectedContentType", "size", "state", "objectKey", "createdAt", "references"]) });
    for (const [referencePosition, reference] of (file.references || []).entries()) {
      rows.file_references.push({ file_id: file.fileId, reference_type: reference.type, reference_id: reference.id, field: reference.field, position: referencePosition, data: without(reference, ["type", "id", "field"]) });
    }
  }
  for (const photo of (store.catalogItemPhotos || [])) {
    rows.supplier_catalog_item_photos.push({
      catalog_item_id: photo.catalogItemId, file_id: photo.fileId, sort_order: photo.sortOrder,
      alt_text: photo.altText ?? null, created_at: photo.createdAt,
    });
  }
  for (const media of (store.supplierShopMedia || [])) {
    rows.supplier_shop_media.push({
      supplier_id: media.supplierId, slot: media.slot, file_id: media.fileId, updated_at: media.updatedAt,
    });
  }
  for (const account of (store.supplierPayoutAccounts || [])) {
    rows.supplier_payout_accounts.push({
      supplier_id: account.supplierId, provider: account.provider, account_name: account.accountName,
      account_number: account.accountNumber ?? null, institution: account.institution ?? null,
      qr_file_id: account.qrFileId ?? null, version: account.version || 1, updated_at: account.updatedAt,
    });
  }
  for (const document of (store.riderDocuments || [])) {
    rows.rider_documents.push({ id: document.id, rider_id: document.riderId, kind: document.kind, file_id: document.fileId, expires_on: document.expiresOn ?? null, is_current: document.isCurrent !== false, uploaded_at: document.uploadedAt, replaced_at: document.replacedAt ?? null });
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

const domainBaselines = new WeakMap();
export function originalDomainStore(store) { return domainBaselines.get(store); }
function attachBaseline(store, rows) {
  domainBaselines.set(store, structuredClone(store));
  Object.defineProperty(store, BASELINE, { value: structuredClone(rows), writable: true, enumerable: false });
  return store;
}

function ordered(rows) {
  return [...rows].sort((a, b) => a.position - b.position);
}

/**
 * A measurement as four columns.
 *
 * Split rather than stored as JSON so the check constraints hold: a width with
 * no height is not an area, and the database is where that stays true.
 */
function measurementColumns(measurement) {
  return {
    measure_pages: measurement?.pages ?? null,
    measure_width_milli: measurement?.width ?? null,
    measure_height_milli: measurement?.height ?? null,
    measure_length_milli: measurement?.length ?? null,
  };
}

/** The same four columns as the shape `src/pricing.js` bills from, or null. */
function readMeasurement(row) {
  const measurement = {};
  if (row.measure_pages != null) measurement.pages = row.measure_pages;
  if (row.measure_width_milli != null) measurement.width = row.measure_width_milli;
  if (row.measure_height_milli != null) measurement.height = row.measure_height_milli;
  if (row.measure_length_milli != null) measurement.length = row.measure_length_milli;
  return Object.keys(measurement).length ? measurement : null;
}

function orderedBy(rows, ...columns) {
  return [...rows].sort((a, b) => {
    for (const column of columns) {
      const comparison = String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
      if (comparison) return comparison;
    }
    return 0;
  });
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
    const item = { ...row.data, id: row.id, clerkUserId: row.clerk_user_id, email: row.email, name: row.name, role: row.role, version: row.version || 1, createdAt: row.created_at };
    present(item, "phone", row.phone); present(item, "accountType", row.account_type); present(item, "orgName", row.org_name); present(item, "verificationStatus", row.verification_status);
    if (row.shop_lat != null) item.shop = { lat: row.shop_lat, lng: row.shop_lng, label: row.shop_label };
    return item;
  });
  store.userRoleMemberships = orderedBy(loaded.user_role_memberships, "user_id", "role").map((row) => {
    const item = { userId: row.user_id, role: row.role, createdAt: row.created_at };
    present(item, "createdBy", row.created_by);
    return item;
  });
  store.clientProfiles = orderedBy(loaded.client_profiles, "user_id").map((row) => {
    const item = { userId: row.user_id, clientKind: row.client_kind, updatedAt: row.updated_at };
    present(item, "businessName", row.business_name);
    present(item, "businessNature", row.business_nature);
    return item;
  });
  store.clientPreferences = orderedBy(loaded.client_match_preferences, "client_id").map((row) => ({
    userId: row.client_id, ranking: row.ranking, version: row.version, updatedAt: row.updated_at,
  }));
  store.clientAddresses = orderedBy(loaded.client_saved_addresses, "client_id", "created_at", "id").map((row) => ({
    id: row.id, clientId: row.client_id, label: row.label, addressLine: row.address_line,
    point: { lat: row.lat, lng: row.lng }, isDefault: row.is_default, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.supplierProfiles = orderedBy(loaded.supplier_profiles, "user_id").map((row) => {
    const item = { userId: row.user_id, shopName: row.shop_name, contactName: row.contact_name, shop: { lat: row.shop_lat, lng: row.shop_lng, label: row.shop_label }, pickupAvailable: row.pickup_available, version: row.version || 1, updatedAt: row.updated_at };
    if (row.is_closed) item.isClosed = true;
    // Absent means the shop has not set its own hours and is scheduled against
    // the platform default -- never "open at all times".
    if (row.schedule) item.schedule = row.schedule;
    return item;
  });
  store.shopReviews = orderedBy(loaded.shop_reviews, "supplier_id", "created_at", "id").map((row) => ({
    id: row.id,
    orderId: row.order_id,
    supplierId: row.supplier_id,
    clientId: row.client_id,
    qualityStars: row.quality_stars,
    speedStars: row.speed_stars,
    valueStars: row.value_stars,
    comment: row.comment,
    createdAt: row.created_at,
  }));
  store.supplierPaymentTerms = orderedBy(loaded.supplier_payment_terms, "supplier_id").map((row) => ({
    supplierId: row.supplier_id,
    deliveryDownpaymentRateBps: row.delivery_downpayment_rate_bps,
    pickupFullOnlineEnabled: row.pickup_full_online_enabled,
    pickupDownpaymentStoreEnabled: row.pickup_downpayment_store_enabled,
    pickupDownpaymentRateBps: row.pickup_downpayment_rate_bps,
    version: row.version || 1,
    updatedAt: row.updated_at,
  }));
  store.riderProfiles = orderedBy(loaded.rider_profiles, "user_id").map((row) => {
    const item = { userId: row.user_id, vehicleType: row.vehicle_type, plateNumber: row.plate_number, version: row.version || 1, updatedAt: row.updated_at };
    present(item, "licenseNumber", row.license_number);
    return item;
  });
  store.approvalCases = orderedBy(loaded.approval_cases, "created_at", "id").map((row) => {
    const item = { id: row.id, userId: row.user_id, kind: row.kind, status: row.status, version: row.version, applicationRevision: row.application_revision, createdAt: row.created_at, updatedAt: row.updated_at };
    present(item, "submittedAt", row.submitted_at);
    present(item, "decidedAt", row.decided_at);
    present(item, "decidedBy", row.decided_by);
    present(item, "rejectionReason", row.rejection_reason);
    present(item, "suspensionReason", row.suspension_reason);
    return item;
  });
  store.approvalCaseEvents = orderedBy(loaded.approval_case_events, "created_at", "id").map((row) => {
    const item = { id: row.id, approvalCaseId: row.approval_case_id, applicationRevision: row.application_revision, toStatus: row.to_status, actorKind: row.actor_kind, requestId: row.request_id, snapshot: row.snapshot, createdAt: row.created_at };
    present(item, "fromStatus", row.from_status);
    present(item, "actorUserId", row.actor_user_id);
    present(item, "reason", row.reason);
    return item;
  });
  store.catalog = ordered(loaded.catalog_products).map((row) => ({ ...row.data, id: row.id, name: row.name, family: row.family, basePriceMinor: row.base_price_minor, unit: row.unit }));
  store.taxonomy.categories = ordered(loaded.taxonomy_categories).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, active: row.active, sortOrder: row.sort_order }));
  store.taxonomy.categoryAliases = ordered(loaded.taxonomy_category_aliases).map((row) => ({ ...row.data, code: row.code, categoryCode: row.category_code }));
  store.taxonomy.subcategories = ordered(loaded.taxonomy_subcategories).map((row) => ({ ...row.data, id: row.id, code: row.code, categoryCode: row.category_code, name: row.name, active: row.active, sortOrder: row.sort_order }));
  store.taxonomy.materials = ordered(loaded.taxonomy_materials).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, categoryCodes: row.category_codes, active: row.active }));
  store.taxonomy.finishes = ordered(loaded.taxonomy_finishes).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, categoryCodes: row.category_codes, active: row.active }));
  store.zones = ordered(loaded.zones).map((row) => ({ ...row.data, id: row.id, code: row.code, name: row.name, active: row.active }));
  store.supplierServices = ordered(loaded.supplier_services).map((row) => {
    const item = {
      ...row.data, id: row.id, supplierId: row.supplier_id, categoryCode: row.category_code, state: row.state,
      referenceRateMinor: row.reference_rate_minor, turnaroundHours: row.turnaround_hours,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    present(item, "pricingBasis", row.pricing_basis);
    present(item, "standardTurnaroundHours", row.standard_turnaround_hours);
    if (row.rush_enabled) {
      item.rushEnabled = true;
      present(item, "rushTurnaroundHours", row.rush_turnaround_hours);
      present(item, "rushPriceMinor", row.rush_price_minor);
    }
    if (row.version != null) item.version = row.version;
    return item;
  });
  store.supplierServicePriceTiers = orderedBy(loaded.supplier_service_price_tiers, "supplier_service_id", "sort_order", "id").map((row) => ({
    id: row.id, supplierServiceId: row.supplier_service_id, tierCode: row.tier_code, colorTier: row.color_tier,
    minQuantity: row.min_quantity, maxQuantity: row.max_quantity, unitPriceMinor: row.unit_price_minor, sortOrder: row.sort_order,
  }));
  store.acceptedFileFormats = orderedBy(loaded.accepted_file_formats, "code").map((row) => ({
    code: row.code, displayName: row.display_name, inputKind: row.input_kind,
    extensions: row.extensions || [], mimeTypes: row.mime_types || [], active: row.active,
  }));
  store.supplierServiceFileFormats = orderedBy(loaded.supplier_service_file_formats, "supplier_service_id", "format_code").map((row) => ({
    supplierServiceId: row.supplier_service_id, formatCode: row.format_code,
  }));
  store.catalogItems = orderedBy(loaded.supplier_catalog_items, "supplier_id", "sort_order", "id").map((row) => ({
    id: row.id, supplierId: row.supplier_id, supplierServiceId: row.supplier_service_id,
    subcategoryCode: row.subcategory_code, name: row.name, description: row.description,
    basePriceMinor: row.base_price_minor, pricingUnit: row.pricing_unit, packageQty: row.package_qty,
    measureUnit: row.measure_unit,
    minimumWidthMilli: row.minimum_width_milli, minimumHeightMilli: row.minimum_height_milli,
    minimumLengthMilli: row.minimum_length_milli, minimumOrderQuantity: row.minimum_order_quantity,
    printerMaxWidthFeet: row.printer_max_width_feet,
    turnaroundMode: row.turnaround_mode, turnaroundHours: row.turnaround_hours,
    minimumTurnaroundHours: row.minimum_turnaround_hours ?? null,
    fileFormatMode: row.file_format_mode, active: row.active, sortOrder: row.sort_order,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.catalogOptionGroups = orderedBy(loaded.supplier_catalog_option_groups, "catalog_item_id", "sort_order", "id").map((row) => ({
    id: row.id, catalogItemId: row.catalog_item_id, name: row.name, kind: row.kind, helpText: row.help_text,
    required: row.required, selectionMode: row.selection_mode, sortOrder: row.sort_order,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.catalogOptions = orderedBy(loaded.supplier_catalog_options, "option_group_id", "sort_order", "id").map((row) => ({
    id: row.id, optionGroupId: row.option_group_id, label: row.label,
    priceModifierMinor: row.price_modifier_minor, priceMultiplierBps: row.price_multiplier_bps,
    specBinding: row.spec_binding,
    active: row.active, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.catalogPriceTiers = orderedBy(loaded.supplier_catalog_price_tiers, "catalog_item_id", "min_quantity", "id").map((row) => ({
    id: row.id, catalogItemId: row.catalog_item_id, minQuantity: row.min_quantity,
    unitPriceMinor: row.unit_price_minor, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.catalogSpeedTiers = orderedBy(loaded.supplier_catalog_speed_tiers, "catalog_item_id", "turnaround_hours", "id").map((row) => ({
    id: row.id, catalogItemId: row.catalog_item_id, label: row.label,
    turnaroundHours: row.turnaround_hours, priceMinor: row.price_minor, surchargeMinor: row.surcharge_minor,
    sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.catalogItemFileFormats = orderedBy(loaded.supplier_catalog_item_file_formats, "catalog_item_id", "format_code").map((row) => ({
    catalogItemId: row.catalog_item_id, formatCode: row.format_code,
  }));
  store.catalogPrepSteps = orderedBy(loaded.supplier_catalog_prep_steps, "catalog_item_id", "sort_order", "id").map((row) => ({
    id: row.id, catalogItemId: row.catalog_item_id, sortOrder: row.sort_order,
    title: row.title, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  store.listingStarters = orderedBy(loaded.listing_starters, "subcategory_code", "id").map((row) => ({
    id: row.id, subcategoryCode: row.subcategory_code, name: row.name,
    defaultPricingUnit: row.default_pricing_unit, defaultPackageQty: row.default_package_qty,
    defaultTurnaroundHours: row.default_turnaround_hours, defaultFormatCodes: row.default_format_codes || [],
  }));
  store.listingStarterGroups = orderedBy(loaded.listing_starter_groups, "starter_id", "sort_order", "id").map((row) => ({
    id: row.id, starterId: row.starter_id, name: row.name, kind: row.kind, helpText: row.help_text,
    required: row.required, sortOrder: row.sort_order,
  }));
  store.listingStarterOptions = orderedBy(loaded.listing_starter_options, "starter_group_id", "sort_order", "id").map((row) => ({
    id: row.id, starterGroupId: row.starter_group_id, label: row.label,
    priceModifierMinor: row.price_modifier_minor,
    priceMultiplierBps: row.price_multiplier_bps ?? null,
    specBinding: row.spec_binding, sortOrder: row.sort_order,
  }));
  store.carts = orderedBy(loaded.client_carts, "client_id", "created_at", "id").map((row) => {
    const item = {
      id: row.id, clientId: row.client_id, state: row.state, version: row.version,
      serviceLevel: row.service_level, fulfillmentMode: row.fulfillment_mode,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    present(item, "scheduledFor", row.scheduled_for);
    if (row.default_dropoff_lat != null) item.defaultDropoff = { lat: row.default_dropoff_lat, lng: row.default_dropoff_lng, label: row.default_dropoff_label };
    present(item, "checkedOutOrderId", row.checked_out_order_id);
    present(item, "checkedOutAt", row.checked_out_at);
    return item;
  });
  store.cartLines = orderedBy(loaded.client_cart_lines, "cart_id", "sort_order", "id").map((row) => {
    const item = {
      id: row.id, cartId: row.cart_id, supplierId: row.supplier_id, catalogItemId: row.catalog_item_id,
      optionIds: row.option_ids || [], quantity: row.quantity, structuredSpec: row.structured_spec || {},
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    };
    present(item, "artworkFileId", row.artwork_file_id);
    present(item, "mockupFileId", row.mockup_file_id);
    present(item, "measurement", readMeasurement(row));
    if (row.dropoff_lat != null) item.dropoff = { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label };
    return item;
  });
  store.orderJobs = orderedBy(loaded.order_jobs, "order_id", "created_at", "id").map((row) => {
    const item = {
      id: row.id, orderId: row.order_id, supplierId: row.supplier_id, riderId: row.rider_id,
      state: row.state, fulfillmentMode: row.fulfillment_mode,
      pickup: { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_label },
      supplierSubtotalMinor: row.supplier_subtotal_minor,
      deliveryDistanceMeters: row.delivery_distance_meters,
      deliveryFeeMinor: row.delivery_fee_minor,
      estimatedHours: row.estimated_hours,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (row.dropoff_lat != null) item.dropoff = { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label };
    present(item, "scheduledFor", row.scheduled_for);
    return item;
  });
  store.orderLineItems = orderedBy(loaded.order_line_items, "order_id", "sort_order", "id").map((row) => ({
    id: row.id, orderId: row.order_id, sourceCatalogItemId: row.source_catalog_item_id,
    sourceSupplierServiceId: row.source_supplier_service_id, itemNameSnapshot: row.item_name_snapshot,
    descriptionSnapshot: row.description_snapshot, pricingBasisSnapshot: row.pricing_basis_snapshot,
    pricingUnitSnapshot: row.pricing_unit_snapshot, packageQtySnapshot: row.package_qty_snapshot,
    turnaroundHoursSnapshot: row.turnaround_hours_snapshot, baseUnitPriceMinor: row.base_unit_price_minor,
    effectiveUnitPriceMinor: row.effective_unit_price_minor, quantity: row.quantity,
    lineSubtotalMinor: row.line_subtotal_minor, acceptedFormatCodesSnapshot: row.accepted_format_codes_snapshot,
    structuredSpecSnapshot: row.structured_spec_snapshot, sortOrder: row.sort_order,
    ...(readMeasurement(row) ? { measurement: readMeasurement(row) } : {}),
    snapshotFinalized: row.snapshot_finalized, createdAt: row.created_at,
    ...(row.job_id == null ? {} : { jobId: row.job_id }),
    ...(row.artwork_file_id == null ? {} : { artworkFileId: row.artwork_file_id }),
    ...(row.mockup_file_id == null ? {} : { mockupFileId: row.mockup_file_id }),
    ...(row.dropoff_lat == null ? {} : { dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label } }),
  }));
  store.orderLineItemOptions = orderedBy(loaded.order_line_item_options, "order_line_item_id", "sort_order", "id").map((row) => ({
    id: row.id, orderLineItemId: row.order_line_item_id, sourceOptionGroupId: row.source_option_group_id,
    sourceOptionId: row.source_option_id, groupNameSnapshot: row.group_name_snapshot,
    groupKindSnapshot: row.group_kind_snapshot, optionLabelSnapshot: row.option_label_snapshot,
    priceModifierMinor: row.price_modifier_minor, sortOrder: row.sort_order,
  }));
  store.orderInvoices = orderedBy(loaded.order_invoices, "issued_at", "order_id").map((row) => ({
    orderId: row.order_id, invoiceNumber: row.invoice_number, issuedAt: row.issued_at, snapshot: row.snapshot,
  }));

  const payments = new Map();
  for (const row of ordered(loaded.order_payments)) {
    if (!payments.has(row.order_id)) payments.set(row.order_id, {});
    payments.get(row.order_id)[row.code] = { ...row.data, amountMinor: row.amount_minor, method: row.method, status: row.status };
  }
  const paymentAllocations = new Map();
  for (const row of orderedBy(loaded.order_payment_allocations, "payment_code", "component")) {
    if (!paymentAllocations.has(row.order_id)) paymentAllocations.set(row.order_id, []);
    paymentAllocations.get(row.order_id).push({
      paymentCode: row.payment_code,
      component: row.component,
      amountMinor: row.amount_minor,
    });
  }
  const revenueAdjustments = new Map();
  for (const row of orderedBy(loaded.platform_revenue_adjustments, "created_at", "id")) {
    if (!revenueAdjustments.has(row.order_id)) revenueAdjustments.set(row.order_id, []);
    revenueAdjustments.get(row.order_id).push({
      id: row.id,
      kind: row.kind,
      amountMinor: row.amount_minor,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    });
  }
  const milestones = new Map();
  for (const row of ordered(loaded.payout_milestones)) {
    if (!milestones.has(row.order_id)) milestones.set(row.order_id, []);
    milestones.get(row.order_id).push({ ...row.data, code: row.code, sharePercent: row.share_percent, amountMinor: row.amount_minor, status: row.status });
  }
  store.orders = ordered(loaded.orders).map((row) => {
    const item = {
      ...row.data,
      id: row.id,
      clientId: row.client_id,
      supplierId: row.supplier_id,
      riderId: row.rider_id,
      productId: row.product_id,
      state: row.state,
      ...(row.ready_by ? { readyBy: row.ready_by } : {}),
      ...(row.ready_at ? { readyAt: row.ready_at } : {}),
      ...(row.cancelled_at ? {
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by,
        cancellationReason: row.cancellation_reason,
      } : {}),
      zone: row.zone_code,
      supplierSubtotalMinor: row.supplier_subtotal_minor,
      subtotalMinor: row.subtotal_minor,
      serviceFeeRateBps: row.service_fee_rate_bps,
      serviceFeeMinor: row.service_fee_minor,
      deliveryFeeMinor: row.delivery_fee_minor,
      totalMinor: row.total_minor,
      fulfillmentMode: row.fulfillment_mode,
      paymentPlan: row.payment_plan,
      quoteVersion: row.quote_version,
      supplierDownpaymentRateBps: row.supplier_downpayment_rate_bps,
      onlineDueMinor: row.online_due_minor,
      directStoreDueMinor: row.direct_store_due_minor,
      supplierPlatformPayoutMinor: row.supplier_platform_payout_minor,
      commercialCommittedAt: row.commercial_committed_at,
      moneyModelVersion: row.money_model_version,
      payoutHold: row.payout_hold,
      pickup: row.pickup_lat == null ? null : { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_label },
      dropoff: row.dropoff_lat == null ? null : { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label },
      payments: payments.get(row.id) || {},
      paymentAllocations: paymentAllocations.get(row.id) || [],
      revenueAdjustments: revenueAdjustments.get(row.id) || [],
      payoutMilestones: milestones.get(row.id) || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    present(item, "issueWindowOpenedAt", row.issue_window_opened_at);
    present(item, "issueWindowExpiresAt", row.issue_window_expires_at);
    if (!Array.isArray(item.timeline)) item.timeline = [];
    return item;
  });

  const references = new Map();
  for (const row of ordered(loaded.file_references)) {
    if (!references.has(row.file_id)) references.set(row.file_id, []);
    references.get(row.file_id).push({ ...row.data, type: row.reference_type, id: row.reference_id, field: row.field });
  }
  store.files = ordered(loaded.files).map((row) => ({ ...row.data, fileId: row.file_id, ownerId: row.owner_id, purpose: row.purpose, originalFilename: row.original_filename, declaredContentType: row.declared_content_type, detectedContentType: row.detected_content_type, size: row.size_bytes, state: row.state, objectKey: row.object_key, references: references.get(row.file_id) || [], createdAt: row.created_at }));
  store.catalogItemPhotos = orderedBy(loaded.supplier_catalog_item_photos, "catalog_item_id", "sort_order", "file_id").map((row) => ({
    catalogItemId: row.catalog_item_id, fileId: row.file_id, sortOrder: row.sort_order, altText: row.alt_text, createdAt: row.created_at,
  }));
  store.supplierShopMedia = orderedBy(loaded.supplier_shop_media, "supplier_id", "slot").map((row) => ({
    supplierId: row.supplier_id, slot: row.slot, fileId: row.file_id, updatedAt: row.updated_at,
  }));
  store.supplierPayoutAccounts = orderedBy(loaded.supplier_payout_accounts, "supplier_id").map((row) => ({
    supplierId: row.supplier_id, provider: row.provider, accountName: row.account_name,
    accountNumber: row.account_number, institution: row.institution, qrFileId: row.qr_file_id,
    version: row.version || 1, updatedAt: row.updated_at,
  }));
  store.riderDocuments = orderedBy(loaded.rider_documents, "uploaded_at", "id").map((row) => {
    const item = { id: row.id, riderId: row.rider_id, kind: row.kind, fileId: row.file_id, isCurrent: row.is_current, uploadedAt: row.uploaded_at };
    present(item, "expiresOn", row.expires_on);
    present(item, "replacedAt", row.replaced_at);
    return item;
  });

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
  store.deviceTokens = ordered(loaded.device_tokens).map(deviceTokenItem);
  attachBaseline(store, rowsFromStore(store));
  Object.defineProperty(store, "listOwnCatalogItems", {
    value: (params) => listOwnCatalogItems(database, params),
    enumerable: false,
    writable: true,
  });
  return store;
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
    if (table.appendOnly) throw new Error(`${table.name} rows are append-only`);
    const where = table.keys.map((column, index) => `${column} = $${index + 1}`).join(" AND ");
    await database.query(`DELETE FROM ${table.name} WHERE ${where}`, table.keys.map((column) => row[column]));
  }
}

async function upsertChanged(database, table, before, current) {
  for (const [key, row] of current) {
    if (before.has(key) && stable(before.get(key)) === stable(row)) continue;
    if (table.appendOnly && before.has(key)) throw new Error(`${table.name} rows are append-only`);
    const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(", ");
    if (table.appendOnly) {
      await database.query(
        `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders})`,
        table.columns.map((column) => row[column]),
      );
      continue;
    }
    const updatable = table.columns.filter((column) => !table.keys.includes(column));
    // Junction tables are all-key rows. `DO UPDATE SET` with an empty list is
    // a syntax error, which is how creating a listing from a GRIDGO starter
    // (it writes catalog item file-format rows) answered 500.
    if (updatable.length === 0) {
      await database.query(
        `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${table.keys.join(", ")}) DO NOTHING`,
        table.columns.map((column) => row[column]),
      );
      continue;
    }
    const updates = updatable.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
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
    if (table.name === "order_line_items") {
      // New (or still-open) lines must land with snapshot_finalized=false, then
      // the follow-up UPDATE sets it true. Already-finalized rows are immutable:
      // flipping them false on an unrelated save (Create listing, seed, …) raises
      // `order line snapshots are immutable` and 500s the request.
      const toWrite = new Map();
      for (const [key, row] of current) {
        const prev = before.get(key);
        if (prev && stable(prev) === stable(row)) continue;
        if (prev?.snapshot_finalized) continue;
        toWrite.set(key, { ...row, snapshot_finalized: false });
      }
      await upsertChanged(database, table, before, toWrite);
      continue;
    }
    await upsertChanged(database, table, before, current);
  }
  for (const row of currentRows.order_line_items || []) {
    if (row.snapshot_finalized) {
      await database.query("UPDATE order_line_items SET snapshot_finalized = true WHERE id = $1", [row.id]);
    }
  }
  if (Object.hasOwn(store, BASELINE)) {
    store[BASELINE] = structuredClone(currentRows);
    domainBaselines.set(store, structuredClone(store));
  } else {
    attachBaseline(store, currentRows);
  }
}

export function originalNotificationIds(store) {
  return new Set((store[BASELINE]?.notifications || []).map((row) => row.id));
}

const CATALOG_LIST_SORTS = new Set(["board", "name", "price_low", "price_high", "fastest"]);
const FASTEST_HOURS_SENTINEL = 2147483647;

function catalogListError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function encodeCatalogCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function nextSqlParam(values, value) {
  values.push(value);
  return `$${values.length}`;
}

function catalogOrderSql(sort, hasQuery) {
  const rank = hasQuery ? "hits.rank DESC, " : "";
  switch (sort) {
    case "name":
      return `${rank}lower(hits.name) ASC, hits.id ASC`;
    case "price_low":
      return `${rank}hits.base_price_minor ASC, hits.id ASC`;
    case "price_high":
      return `${rank}hits.base_price_minor DESC, hits.id ASC`;
    case "fastest":
      return `${rank}COALESCE(hits.effective_hours, ${FASTEST_HOURS_SENTINEL}) ASC, hits.id ASC`;
    default:
      return `${rank}hits.sort_order ASC, hits.id ASC`;
  }
}

function catalogSecondaryCursorSql(sort, cursor, values) {
  const key = Array.isArray(cursor.k) ? cursor.k[1] : cursor.k;
  const idParam = nextSqlParam(values, String(cursor.id));
  if (sort === "name") {
    const keyParam = nextSqlParam(values, String(key ?? ""));
    return `(lower(hits.name), hits.id) > (${keyParam}, ${idParam})`;
  }
  if (sort === "price_high") {
    const keyParam = nextSqlParam(values, Number(key));
    return `(hits.base_price_minor < ${keyParam} OR (hits.base_price_minor = ${keyParam} AND hits.id > ${idParam}))`;
  }
  if (sort === "price_low") {
    const keyParam = nextSqlParam(values, Number(key));
    return `(hits.base_price_minor, hits.id) > (${keyParam}, ${idParam})`;
  }
  if (sort === "fastest") {
    const keyParam = nextSqlParam(values, Number(key ?? FASTEST_HOURS_SENTINEL));
    return `(COALESCE(hits.effective_hours, ${FASTEST_HOURS_SENTINEL}), hits.id) > (${keyParam}, ${idParam})`;
  }
  const keyParam = nextSqlParam(values, Number(key ?? 0));
  return `(hits.sort_order, hits.id) > (${keyParam}, ${idParam})`;
}

function catalogCursorSql(sort, hasQuery, cursor, values) {
  if (!cursor?.id) return "";
  const secondary = catalogSecondaryCursorSql(sort, cursor, values);
  if (!hasQuery) return `AND ${secondary}`;
  const rank = Array.isArray(cursor.k) ? cursor.k[0] : cursor.k;
  if (rank == null || Number.isNaN(Number(rank))) {
    throw catalogListError(400, "invalid_cursor", "The catalog cursor is invalid. Start again without it.");
  }
  const rankParam = nextSqlParam(values, Number(rank));
  return `AND (hits.rank < ${rankParam} OR (hits.rank = ${rankParam} AND ${secondary}))`;
}

function catalogHitsCte() {
  return `
    WITH params AS (
      SELECT $1::text AS supplier_id,
             NULLIF($2::text, '') AS q,
             CASE WHEN NULLIF($2::text, '') IS NULL THEN NULL
                  ELSE websearch_to_tsquery('simple', $2)
             END AS tsq
    ),
    filtered AS (
      SELECT item.id, item.supplier_id, item.supplier_service_id, item.subcategory_code,
             item.name, item.description, item.base_price_minor, item.pricing_unit,
             item.package_qty, item.turnaround_mode, item.turnaround_hours,
             item.file_format_mode, item.active, item.sort_order, item.version,
             item.created_at, item.updated_at, item.search_text, item.search_tsv,
             item.printer_max_width_feet,
             COALESCE(item.turnaround_hours, service.standard_turnaround_hours, service.turnaround_hours)
               AS effective_hours
        FROM supplier_catalog_items item
        JOIN supplier_services service ON service.id = item.supplier_service_id
        CROSS JOIN params
       WHERE item.supplier_id = params.supplier_id
         AND ($3::text IS NULL OR item.subcategory_code = $3)
         AND ($4::boolean IS NULL OR item.active = $4)
    ),
    fts AS (
      SELECT filtered.*, ts_rank_cd(filtered.search_tsv, params.tsq)::float8 AS rank
        FROM filtered
        CROSS JOIN params
       WHERE params.tsq IS NOT NULL
         AND params.tsq <> ''::tsquery
         AND filtered.search_tsv @@ params.tsq
    ),
    trgm AS (
      SELECT filtered.*, public.similarity(filtered.search_text, params.q)::float8 AS rank
        FROM filtered
        CROSS JOIN params
       WHERE params.q IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = filtered.id)
         AND (
           filtered.search_text OPERATOR(public.%) params.q
           OR filtered.search_text ILIKE '%' || params.q || '%'
         )
    ),
    hits AS (
      SELECT * FROM fts
      UNION ALL
      SELECT * FROM trgm
      UNION ALL
      SELECT filtered.*, 0::float8 AS rank
        FROM filtered
        CROSS JOIN params
       WHERE params.q IS NULL
    )
  `;
}

function catalogItemFromListRow(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierServiceId: row.supplier_service_id,
    subcategoryCode: row.subcategory_code,
    name: row.name,
    description: row.description,
    basePriceMinor: row.base_price_minor,
    pricingUnit: row.pricing_unit,
    packageQty: row.package_qty,
    turnaroundMode: row.turnaround_mode,
    turnaroundHours: row.turnaround_hours,
    fileFormatMode: row.file_format_mode,
    active: row.active,
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    printerMaxWidthFeet: row.printer_max_width_feet ?? null,
  };
}

function catalogSecondaryFromRow(row, sort) {
  switch (sort) {
    case "name":
      return String(row.name || "").toLowerCase();
    case "price_low":
    case "price_high":
      return row.base_price_minor;
    case "fastest":
      return row.effective_hours ?? FASTEST_HOURS_SENTINEL;
    default:
      return row.sort_order ?? 0;
  }
}

async function queryOwnCatalogItems(database, params) {
  const {
    supplierId,
    q = null,
    sort = "board",
    limit = 20,
    cursor = null,
    subcategoryCode = null,
    active = null,
  } = params;
  if (!CATALOG_LIST_SORTS.has(sort)) {
    throw catalogListError(400, "invalid_catalog_query", "sort must be board, name, price_low, price_high, or fastest.", {
      field: "sort",
    });
  }

  const hasQuery = Boolean(q);
  const cte = catalogHitsCte();
  const filterValues = [supplierId, q, subcategoryCode, active];
  const total = Number(
    (await database.query(`${cte} SELECT count(*)::int AS total FROM hits`, filterValues)).rows[0]?.total || 0,
  );

  const pageValues = [...filterValues];
  const cursorSql = catalogCursorSql(sort, hasQuery, cursor, pageValues);
  const limitParam = nextSqlParam(pageValues, limit + 1);
  const rows = (await database.query(
    `${cte}
     SELECT hits.*
       FROM hits
      WHERE TRUE ${cursorSql}
      ORDER BY ${catalogOrderSql(sort, hasQuery)}
      LIMIT ${limitParam}`,
    pageValues,
  )).rows;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : null;
  return {
    items: page.map(catalogItemFromListRow),
    nextCursor: last
      ? encodeCatalogCursor({
          k: hasQuery ? [last.rank, catalogSecondaryFromRow(last, sort)] : catalogSecondaryFromRow(last, sort),
          id: last.id,
        })
      : null,
    total,
  };
}

export async function listOwnCatalogItems(database, params) {
  const run = () => queryOwnCatalogItems(database, params);
  if (!database.inTransaction()) return database.snapshot(run);
  return run();
}
