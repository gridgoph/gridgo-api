import {
  assertExpectedVersion,
  bumpVersion,
  privateCatalogItem,
  validateSpecBinding,
} from "./supplier-catalog.js";
import { identityHasMembership } from "./authorization-context.js";
import { READY_TIME_CHIPS } from "./product-template-data.js";
import { defaultListingStarters } from "./listing-starters.js";
import { previewProductionTime } from "./production-time-preview.js";
import {
  fail,
  object,
  positive,
  text,
  templateFor,
  templateNotice,
} from "./product-template-common.js";
import { createProduct, priceRows } from "./product-template-products.js";
import { migrationPlan } from "./product-template-migration.js";
export { templateNotice } from "./product-template-common.js";
export { convertPriceTable } from "./product-template-products.js";
export { migrationPlan } from "./product-template-migration.js";
export async function routeProductTemplates(args) {
  const { req, url, store, user } = args,
    path = url.pathname;
  const own =
    /^\/me\/(?:product-templates|template-products|product-setup-requests)(?:\/|$)/.test(
      path,
    );
  const staff =
    path.startsWith("/ops/product-templates") ||
    path.startsWith("/ops/product-setup-requests") ||
    /^\/ops\/shops\/[^/]+\/(template-products|template-migration)/.test(path);
  if (!own && !staff) return null;
  if (!user) fail("unauthorized", "Sign in first.", 401);
  if (
    !(staff ? ["ops_admin", "super_admin"] : ["supplier"]).some((r) =>
      identityHasMembership(user, r),
    )
  )
    fail("forbidden", "This role cannot manage template products.", 403);
  store.productTemplates ||= [];
  store.productSetupRequests ||= [];
  if (
    (path === "/me/product-templates" || path === "/ops/product-templates") &&
    req.method === "GET"
  ) {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length > 120)
      fail("invalid_query", "Search is limited to 120 characters.");
    const machines = (url.searchParams.get("machines") || "")
      .split(",")
      .filter(Boolean);
    const templates = store.productTemplates
      .filter(
        (t) =>
          (staff || t.active !== false) &&
          (!q ||
            `${t.name} ${t.group} ${t.options.map((o) => o.label).join(" ")}`
              .toLowerCase()
              .includes(q)) &&
          (!url.searchParams.get("group") ||
            t.group === url.searchParams.get("group")),
      )
      .map((t) => ({
        ...t,
        ...(!staff
          ? {
              addedItemIds: store.catalogItems
                .filter(
                  (i) =>
                    i.supplierId === user.id &&
                    i.templateData?.templateId === t.id &&
                    !i.templateData?.mergedInto,
                )
                .map((i) => i.id),
              machineMatch: machines.length
                ? t.machinesNeeded.every((m) => machines.includes(m))
                : null,
            }
          : {}),
      }));
    return {
      status: 200,
      body: {
        templates,
        readyTimes: READY_TIME_CHIPS,
        ...(!staff
          ? {
              checkYourProducts: {
                ...migrationPlan(store, user.id),
                unpricedItemIds: store.catalogItems
                  .filter(
                    (i) =>
                      i.supplierId === user.id && i.templateData?.needsPrice,
                  )
                  .map((i) => i.id),
              },
            }
          : {}),
      },
    };
  }
  if (/^\/ops\/product-templates\/[^/]+$/.test(path) && req.method === "PUT") {
    const body = object(await args.readBody(req)),
      template = object(body.template),
      key = decodeURIComponent(path.split("/")[3]);
    const current = store.productTemplates.find((t) => t.id === key);
    if (current)
      assertExpectedVersion(
        req,
        body,
        "product_template_stale",
        current.version,
      );
    validateTemplate(store, { ...template, id: key });
    const next = {
      ...structuredClone(template),
      id: key,
      version: (current?.version || 0) + 1,
    };
    store.productTemplates = store.productTemplates.filter((t) => t.id !== key);
    store.productTemplates.push(next);
    args.audit?.(store, {
      actor: user,
      action: "product_template.save",
      entityType: "product_template",
      entityId: key,
      detail: { version: next.version },
    });
    templateNotice(
      store,
      {},
      args,
      "product_template_updated",
      "The product template catalogue was updated.",
    );
    for (const r of store.productSetupRequests.filter(
      (r) =>
        next.active !== false &&
        r.kind === "template" &&
        r.status === "pending" &&
        r.requestedName.toLowerCase() === next.name.toLowerCase(),
    )) {
      r.status = "completed";
      r.templateId = key;
      bumpVersion(r, args.now());
      templateNotice(
        store,
        r,
        args,
        "template_request_completed",
        "Your requested template is available. Open Products to add it.",
      );
    }
    return { status: 200, body: { template: next }, mutated: true };
  }
  const closeRequests = path.match(
    /^\/ops\/product-templates\/([^/]+)\/resolve-requests$/,
  );
  if (closeRequests && req.method === "POST") {
    const template = templateFor(store, decodeURIComponent(closeRequests[1])),
      body = object(await args.readBody(req));
    if (
      !Array.isArray(body.requests) ||
      !body.requests.length ||
      body.requests.length > 100
    )
      fail("invalid_template_request", "Select pending product-type requests.");
    const requests = body.requests.map((selection) => {
      const request = (store.productTypeRequests || []).find(
        (r) => r.id === selection.id && r.status === "pending",
      );
      if (!request)
        fail(
          "product_type_request_not_pending",
          "Refresh the pending requests.",
          409,
        );
      assertExpectedVersion(
        req,
        { expectedVersion: selection.expectedVersion },
        "product_type_request_stale",
        request.version,
      );
      if (request.categoryCode !== template.categoryCode)
        fail(
          "invalid_template_request",
          "Choose a template in the requested category.",
        );
      return request;
    });
    for (const r of requests) {
      r.status = "approved";
      r.productTypeCode = template.subcategoryCode;
      r.reason = null;
      r.reviewedBy = user.id;
      r.reviewedAt = args.now();
      bumpVersion(r, args.now());
      args.audit?.(store, {
        actor: user,
        action: "product_type.resolve_with_template",
        entityType: "product_type_request",
        entityId: r.id,
        detail: { templateId: template.id },
      });
      templateNotice(
        store,
        r,
        args,
        "template_request_completed",
        "Your requested product is available as a template. Open Products to add it.",
      );
    }
    return { status: 200, body: { requests }, mutated: true };
  }
  if (path === "/me/template-products/preview" && req.method === "POST") {
    const body = object(await args.readBody(req));
    const previewStore = structuredClone(store);
    const existing = body.itemId
      ? previewStore.catalogItems.find(
          (i) =>
            i.id === body.itemId && i.supplierId === user.id && i.templateData,
        )
      : null;
    if (body.itemId && !existing)
      fail("catalog_item_not_found", "Product not found.", 404);
    const item = createProduct(
      previewStore,
      user.id,
      body,
      { ...args, audit: undefined },
      false,
      existing,
    );
    const chip = READY_TIME_CHIPS.find((c) => c.code === body.readyTime);
    return {
      status: 200,
      body: {
        item: privateCatalogItem(previewStore, item),
        prices: priceRows(previewStore, item),
        ...previewProductionTime(previewStore, item, chip.productionTime, {
          now: args.now(),
          days: 7,
        }),
      },
    };
  }
  const shop = path.match(
    /^\/ops\/shops\/([^/]+)\/(template-products|template-migration)(?:\/([^/]+))?$/,
  );
  if (shop?.[2] === "template-migration" && req.method === "POST") {
    const body = object(await args.readBody(req)),
      plan = migrationPlan(store, decodeURIComponent(shop[1]), body);
    if (body.dryRun !== false)
      return { status: 200, body: { ...plan, dryRun: true } };
    for (const action of plan.actions)
      for (const row of action.variants || [action])
        if (body.expectedVersions?.[row.itemId] !== row.expectedVersion)
          fail(
            "catalog_item_stale",
            "Preview again before applying changes.",
            409,
          );
    for (const action of plan.actions) {
      const item = store.catalogItems.find((i) => i.id === action.itemId);
      if (action.action === "merge_variants") {
        const groupId = `${item.id}_merged_variants`;
        store.catalogOptionGroups.push({
          id: groupId,
          catalogItemId: item.id,
          name: "Option",
          kind: "spec",
          required: true,
          selectionMode: "single",
          sortOrder: 0,
          version: 1,
          createdAt: args.now(),
          updatedAt: args.now(),
        });
        item.basePriceMinor = Math.min(
          ...action.variants.map((v) => v.priceMinor),
        );
        action.variants.forEach((v, index) => {
          store.catalogOptions.push({
            id: args.id("sco"),
            optionGroupId: groupId,
            label: v.label,
            priceModifierMinor: v.priceMinor - item.basePriceMinor,
            active: true,
            sortOrder: index,
            createdAt: args.now(),
            updatedAt: args.now(),
          });
          if (v.itemId !== item.id) {
            const source = store.catalogItems.find((i) => i.id === v.itemId);
            source.active = false;
            source.templateData = {
              templateId: action.templateId,
              mergedInto: item.id,
              migratedAt: args.now(),
              shopConfirmed: true,
            };
            bumpVersion(source, args.now());
          }
        });
      }
      item.templateData = {
        templateId: action.templateId || null,
        migratedAt: args.now(),
        needsPrice: action.action === "hide_unpriced",
        mergedInto: action.mergedInto || null,
        shopConfirmed: true,
      };
      if (
        action.action === "hide_unpriced" ||
        action.action === "merge_duplicate"
      )
        item.active = false;
      bumpVersion(item, args.now());
      args.audit?.(store, {
        actor: user,
        action: `template_migration.${action.action}`,
        entityType: "supplier_catalog_item",
        entityId: item.id,
        detail: action,
      });
    }
    if (plan.actions.length)
      templateNotice(
        store,
        { supplierId: plan.supplierId },
        args,
        "template_products_check",
        "Check your products and add prices to hidden products.",
      );
    return {
      status: 200,
      body: { ...plan, dryRun: false },
      mutated: plan.actions.length > 0,
    };
  }
  if (shop?.[2] === "template-products" && shop[3] && req.method === "PUT") {
    const body = object(await args.readBody(req)),
      supplierId = decodeURIComponent(shop[1]);
    const item = store.catalogItems.find(
      (i) =>
        i.id === decodeURIComponent(shop[3]) &&
        i.supplierId === supplierId &&
        i.templateData?.managed,
    );
    if (!item)
      fail("catalog_item_not_found", "Template product not found.", 404);
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    return {
      status: 200,
      body: {
        item: privateCatalogItem(
          store,
          createProduct(store, supplierId, body, args, true, item),
        ),
      },
      mutated: true,
    };
  }
  if (
    (path === "/me/template-products" ||
      (shop?.[2] === "template-products" && !shop[3])) &&
    req.method === "POST"
  ) {
    const supplierId = staff ? decodeURIComponent(shop[1]) : user.id;
    const item = createProduct(
      store,
      supplierId,
      await args.readBody(req),
      args,
      staff,
    );
    return {
      status: 201,
      body: { item: privateCatalogItem(store, item) },
      mutated: true,
    };
  }
  const match = path.match(
    /^\/me\/template-products\/([^/]+)(?:\/(confirm|ready-preview))?$/,
  );
  if (match) {
    const item = store.catalogItems.find(
      (i) =>
        i.id === decodeURIComponent(match[1]) &&
        i.supplierId === user.id &&
        i.templateData,
    );
    if (!item) fail("catalog_item_not_found", "Product not found.", 404);
    if (req.method === "GET" && !match[2])
      return {
        status: 200,
        body: {
          item: privateCatalogItem(store, item),
          prices: priceRows(store, item),
        },
      };
    const body = object(await args.readBody(req));
    if (match[2] === "ready-preview" && req.method === "POST") {
      const chip = READY_TIME_CHIPS.find((c) => c.code === body.readyTime);
      if (!chip) fail("invalid_ready_time", "Choose a ready time.");
      return {
        status: 200,
        body: previewProductionTime(store, item, chip.productionTime, {
          now: args.now(),
          days: 7,
        }),
      };
    }
    assertExpectedVersion(req, body, "catalog_item_stale", item.version);
    if (match[2] === "confirm" && req.method === "POST") {
      if (item.templateData.shopConfirmed)
        fail("already_confirmed", "These prices are already confirmed.", 409);
      item.templateData.shopConfirmed = true;
      item.templateData.confirmedAt = args.now();
      item.active = true;
      bumpVersion(item, args.now());
      args.audit?.(store, {
        actor: user,
        action: "template_product.confirm",
        entityType: "supplier_catalog_item",
        entityId: item.id,
        detail: { version: item.version },
      });
      templateNotice(
        store,
        item,
        args,
        "template_product_price_check",
        "Your confirmed product is queued for a price check today.",
      );
      return {
        status: 200,
        body: { item: privateCatalogItem(store, item) },
        mutated: true,
      };
    }
    if (!match[2] && req.method === "PUT")
      return {
        status: 200,
        body: {
          item: privateCatalogItem(
            store,
            createProduct(store, user.id, body, args, false, item),
          ),
        },
        mutated: true,
      };
  }
  if (
    path === "/me/product-setup-requests" ||
    path === "/ops/product-setup-requests"
  ) {
    if (req.method === "GET")
      return {
        status: 200,
        body: {
          requests: store.productSetupRequests
            .filter((r) => staff || r.supplierId === user.id)
            .filter(
              (r) =>
                !url.searchParams.get("status") ||
                r.status === url.searchParams.get("status"),
            )
            .slice(-100),
        },
      };
    if (!staff && req.method === "POST") {
      const body = object(await args.readBody(req));
      if (!["template", "setup"].includes(body.kind))
        fail("invalid_template_request", "Choose template or setup.");
      const fileIds = body.fileIds || [];
      if (!Array.isArray(fileIds) || fileIds.length > 10)
        fail("invalid_setup_file", "Attach up to ten files.");
      for (const fileId of fileIds) {
        const f = store.files.find(
          (f) =>
            f.fileId === fileId &&
            f.ownerId === user.id &&
            f.state === "ready" &&
            f.purpose === "product_setup",
        );
        if (!f)
          fail("invalid_setup_file", "Use your own uploaded setup files.");
      }
      if (!body.message && !fileIds.length)
        fail("invalid_template_request", "Send a message or price-list file.");
      const r = {
        id: args.id("psr"),
        supplierId: user.id,
        kind: body.kind,
        message: body.message ? text(body.message) : null,
        fileIds,
        requestedName:
          body.kind === "template" ? text(body.requestedName, 120) : null,
        status: "pending",
        version: 1,
        createdAt: args.now(),
        updatedAt: args.now(),
      };
      for (const fileId of fileIds) {
        const f = store.files.find((f) => f.fileId === fileId);
        f.references ||= [];
        f.references.push({
          type: "product_setup_request",
          id: r.id,
          field: "fileIds",
        });
      }
      store.productSetupRequests.push(r);
      templateNotice(
        store,
        r,
        args,
        "product_setup_requested",
        body.kind === "template"
          ? "Your template request is with the GRIDGO team. Allow about one working day."
          : "The GRIDGO team will prepare products for you to check.",
      );
      args.audit?.(store, {
        actor: user,
        action: "product_setup.request",
        entityType: "product_setup_request",
        entityId: r.id,
        detail: { kind: r.kind },
      });
      return { status: 201, body: { request: r }, mutated: true };
    }
  }
  if (
    /^\/ops\/product-setup-requests\/[^/]+\/decision$/.test(path) &&
    req.method === "POST"
  ) {
    const body = object(await args.readBody(req)),
      r = store.productSetupRequests.find((r) => r.id === path.split("/")[3]);
    if (!r) fail("setup_request_not_found", "Request not found.", 404);
    assertExpectedVersion(req, body, "setup_request_stale", r.version);
    if (!["completed", "needs_revision"].includes(body.status))
      fail("invalid_review_status", "Choose completed or needs_revision.");
    if (r.kind === "template" && body.status === "completed")
      r.templateId = templateFor(store, body.templateId).id;
    r.status = body.status;
    r.reason = text(body.reason);
    bumpVersion(r, args.now());
    templateNotice(store, r, args, "product_setup_updated", r.reason);
    args.audit?.(store, {
      actor: user,
      action: "product_setup.decision",
      entityType: "product_setup_request",
      entityId: r.id,
      detail: { status: r.status },
    });
    return { status: 200, body: { request: r }, mutated: true };
  }
  return null;
}
function validateTemplate(store, t) {
  text(t.name, 120);
  text(t.description, 4000);
  text(t.group, 80);
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(t.id))
    fail("invalid_template_request", "Use a lowercase template ID.");
  const sub = store.taxonomy.subcategories.find(
    (s) => s.code === t.subcategoryCode && s.active !== false,
  );
  if (!sub || sub.categoryCode !== t.categoryCode)
    fail(
      "invalid_template_request",
      "Choose the canonical category and subcategory.",
    );
  if (
    !["page", "sheet", "sq_ft", "piece"].includes(t.unit) ||
    typeof t.active !== "boolean" ||
    typeof t.express !== "boolean"
  )
    fail("invalid_template_request", "Set unit and switches.");
  if (!Array.isArray(t.options) || !t.options.length || t.options.length > 200)
    fail("invalid_template_options", "Use one to two hundred options.");
  const keys = new Set(),
    labels = new Set();
  for (const o of t.options) {
    object(o);
    text(o.key, 80);
    text(o.label, 100);
    if (keys.has(o.key) || labels.has(o.label.toLowerCase()))
      fail("invalid_template_options", "Use unique options.");
    keys.add(o.key);
    labels.add(o.label.toLowerCase());
    if (o.specBinding != null)
      validateSpecBinding(
        store,
        { categoryCode: t.categoryCode },
        o.specBinding,
      );
  }
  for (const key of ["fileTypes", "machinesNeeded", "clientTips"])
    if (
      !Array.isArray(t[key]) ||
      !t[key].length ||
      t[key].length > 20 ||
      t[key].some((v) => typeof v !== "string" || !v.trim() || v.length > 2000)
    )
      fail("invalid_template_request", `Set ${key}.`);
  if (
    t.fileTypes.some(
      (c) =>
        !store.acceptedFileFormats.some(
          (f) => f.code === c && f.active !== false,
        ),
    )
  )
    fail("invalid_template_request", "Use active file types.");
  if (
    !Array.isArray(t.stockPhotos) ||
    !t.stockPhotos.length ||
    t.stockPhotos.length > 5 ||
    t.stockPhotos.some(
      (p) =>
        !p ||
        !defaultListingStarters().some(
          (starter) => p.url === `/product-template-photos/${starter.id}.jpg`,
        ),
    )
  )
    fail("invalid_template_request", "Choose a governed stock photo.");
  positive(t.priceRange?.minMinor);
  positive(t.priceRange?.maxMinor);
  if (t.priceRange.minMinor > t.priceRange.maxMinor)
    fail("invalid_template_request", "Check the usual-price range.");
}
