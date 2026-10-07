import { approvedCatalogView } from "./catalog-review-state.js";
import {
  CatalogError, catalogItemBlockers, itemTurnaroundHours, listingFitsPrinterCap, supplierCatalogReadiness,
} from "./supplier-catalog.js";
import { supplierMatchBlockersFor } from "./supplier-eligibility.js";
import { projectShopFinish } from "./order-match.js";
import { AvailabilityError, fitsDeadline } from "./availability.js";

// Stable codes and actions are the app contract; messages are display-ready.
const STEPS = {
  account_inactive: ["Your account is not active.", "contact_operations"],
  supplier_profile: ["Complete your shop profile.", "edit_profile"],
  shop_name: ["Add your shop name.", "edit_profile"],
  contact_name: ["Add your shop contact name.", "edit_profile"],
  shop_location: ["Set your shop pickup location.", "edit_profile"],
  shop_closed: ["Your shop is marked closed for new work.", "open_shop"],
  supplier_membership: ["This account has no supplier membership.", "contact_operations"],
  supplier_not_approved: ["Your shop needs Operations approval before clients can match with it.", "view_approval"],
  no_matchable_listing: ["No listing is eligible for matching. Complete the steps listed for your listings, or add a listing.", "edit_listings"],
  owning_service: ["This listing needs a service line belonging to your shop.", "edit_listing"],
  name: ["Add a listing name.", "edit_listing"],
  base_price: ["Set a valid non-negative listing price.", "edit_listing"],
  subcategory: ["Choose a listing subcategory.", "edit_listing"],
  printer_max_width_feet: ["Set the printer maximum width to a whole number from 1 to 20 feet.", "edit_listing"],
  accepted_file_formats: ["Choose accepted artwork formats on this listing or its service line.", "edit_listing_formats"],
  photo: ["Attach at least one fully uploaded listing photo.", "upload_listing_photo"],
  option_group: ["Add or enable at least one option in this option group, or remove the group.", "edit_listing_options"],
  listing_not_approved: ["Operations must approve this listing before clients can match it.", "view_listing_review"],
  listing_suspended: ["Operations must restore this listing before it can be offered again.", "contact_operations"],
  item_inactive: ["This listing is hidden. Make it active to offer it to clients.", "activate_listing"],
  service_not_live: ["The parent service line is not live. Operations must approve or restore it before this listing can match.", "view_service"],
  pickup_payment_terms: ["Enable an available pickup payment option.", "edit_payment_terms"],
  review_ready_service_line: ["Complete at least one live or submitted service line with pricing, turnaround and default artwork formats.", "edit_services"],
  complete_catalog_item: ["Complete and activate at least one listing.", "edit_listings"],
  shop_identity_image: ["Upload a shop identity image to complete your shop setup.", "upload_shop_image"],
  service_not_submitted: ["Submit this service line for review or ask Operations about its status.", "view_service"],
  pricing_basis: ["Set the pricing basis for this service line.", "edit_service"],
  turnaround: ["Set a positive whole-number turnaround for this service line.", "edit_service"],
  service_default_formats: ["Choose default artwork formats for this service line to complete setup. Listings may use their own formats for matching.", "edit_service_formats"],
  printer_capacity_exceeded: ["The requested width exceeds this listing's printer maximum width.", "choose_smaller_width"],
  deadline_not_met: ["This listing cannot meet the selected deadline with the current queue, opening hours, turnaround and quantity capacity.", "choose_later_deadline"],
  shop_never_open: ["The schedule cannot fit this work within the scheduling horizon. Review opening hours, closures and requested quantity.", "review_schedule"],
};

function step(blocker) {
  const [code, optionGroupId] = blocker.startsWith("option_group:")
    ? ["option_group", blocker.slice("option_group:".length)] : [blocker];
  const [message, action] = STEPS[code];
  return { code, message, action, ...(optionGroupId ? { optionGroupId } : {}) };
}

export function readinessRequestInput(url) {
  const query = url.searchParams;
  const input = {};
  for (const field of ["units", "widthFeet"]) {
    if (!query.has(field)) continue;
    const value = Number(query.get(field));
    if (!Number.isFinite(value) || value <= 0 || (field === "units" && !Number.isSafeInteger(value))) {
      throw new CatalogError(400, "invalid_readiness_request", `Send a positive ${field === "units" ? "whole-number quantity" : "width in feet"}.`, { field });
    }
    input[field] = value;
  }
  if (query.has("deadline")) {
    const deadline = query.get("deadline");
    if (!deadline?.trim() || !Number.isFinite(Date.parse(deadline))) {
      throw new CatalogError(400, "invalid_deadline", "Send a valid deadline date and time.", { field: "deadline" });
    }
    input.deadline = new Date(deadline).toISOString();
  }
  return Object.keys(input).length ? input : null;
}

function profileCompletion(store, supplierId, legacy) {
  const profile = (store.supplierProfiles || []).find(row => row.userId === supplierId);
  const missing = [...legacy.missing];
  if (profile) {
    if (!String(profile.shopName || "").trim()) missing.push("shop_name");
    if (!String(profile.contactName || "").trim()) missing.push("contact_name");
    if (!profile.shop || !String(profile.shop.label || "").trim()) missing.push("shop_location");
  }
  const services = (store.supplierServices || []).filter(row => row.supplierId === supplierId).map(service => {
    const missing = [];
    if (!["pending_verification", "live"].includes(service.state)) missing.push("service_not_submitted");
    if (!String(service.pricingBasis || "").trim()) missing.push("pricing_basis");
    const hours = service.turnaroundHours || service.standardTurnaroundHours;
    if (!Number.isFinite(hours) || hours <= 0) missing.push("turnaround");
    if (!(store.supplierServiceFileFormats || []).some(row => row.supplierServiceId === service.id)) {
      missing.push("service_default_formats");
    }
    return { supplierServiceId: service.id, missing: missing.map(step) };
  });
  return { complete: legacy.readyForApproval, missing: missing.map(step), services };
}

/** Diagnostics only: neither legacy setup rules nor matching gates change. */
export function supplierReadinessDetails(store, supplierId, request = null, now = new Date().toISOString()) {
  const legacy = supplierCatalogReadiness(store, supplierId);
  store = approvedCatalogView(store);
  const profile = (store.supplierProfiles || []).find(row => row.userId === supplierId);
  const shopBlockers = supplierMatchBlockersFor(store)(supplierId, profile);
  const items = (store.catalogItems || []).filter(row => row.supplierId === supplierId);
  const listings = items.map(item => {
    const missing = [...new Set([...catalogItemBlockers(store, item, { publicOnly: true }), ...shopBlockers])].map(step);
    return { catalogItemId: item.id, ready: missing.length === 0, missing };
  });
  const ready = listings.some(listing => listing.ready);
  const missing = [...shopBlockers];
  if (!ready) missing.push("no_matchable_listing");
  const requestListings = request ? items.map((item, index) => {
    const base = { catalogItemId: item.id, evaluated: false, eligible: null, missing: [] };
    // Operational blockers are already reported above; never call them request failures.
    if (!listings[index].ready) return base;
    const missing = [];
    if (!listingFitsPrinterCap(item, request, store)) missing.push("printer_capacity_exceeded");
    const service = (store.supplierServices || []).find(row => row.id === item.supplierServiceId);
    try {
      const { projection, queue } = projectShopFinish(store, {
        supplierId, turnaroundHours: itemTurnaroundHours(item, service), units: request.units, now,
      });
      if (!fitsDeadline(projection, request.deadline)) missing.push("deadline_not_met");
      // The client promise includes a platform allowance that is private from the shop.
      return {
        catalogItemId: item.id, evaluated: true, eligible: missing.length === 0, missing: missing.map(step),
        projection: {
          startsAt: projection.startsAt, readyBy: projection.readyBy,
          limitedBy: projection.limitedBy, capacityDays: projection.capacityDays, jobsAhead: queue.jobsAhead,
        },
      };
    } catch (error) {
      if (!(error instanceof AvailabilityError) || error.code !== "shop_never_open") throw error;
      missing.push("shop_never_open");
      return { ...base, evaluated: true, eligible: false, missing: missing.map(step) };
    }
  }) : [];
  return {
    ...legacy,
    operational: { ready, missing: missing.map(step), listings },
    profileCompletion: profileCompletion(store, supplierId, legacy),
    requestEligibility: { evaluated: request !== null, input: request, listings: requestListings },
  };
}
