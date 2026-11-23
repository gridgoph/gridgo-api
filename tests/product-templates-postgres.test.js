import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { resetDatabase } from "./fixtures/reset-database.js";
import { fixture } from "./fixtures/reschedule.js";
import { apiForTest } from "./fixtures/reschedule-http.js";
import { defaultTaxonomy } from "../src/taxonomy.js";
import { defaultAcceptedFileFormats } from "../src/reference-data.js";
import { createOrderLineSnapshot } from "../src/supplier-catalog.js";
import { id } from "./fixtures/reschedule.js";
import { defaultProductTemplates } from "../src/product-template-data.js";

const DATABASE_URL = process.env.DATABASE_URL;
test(
  "HTTP template save/review, stock media, setup intake and old-column upsert round trip",
  { skip: !DATABASE_URL },
  async (t) => {
    const db = createDatabase({ DATABASE_URL });
    t.after(() => db.close());
    await resetDatabase(
      db,
      "TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, product_templates RESTART IDENTITY CASCADE",
    );
    const s = fixture();
    s.productTemplates = defaultProductTemplates();
    s.taxonomy = defaultTaxonomy();
    s.acceptedFileFormats = defaultAcceptedFileFormats();
    s.supplierServices.push({
      ...s.supplierServices[0],
      id: "service_apparel",
      categoryCode: "corporate_event_merch",
    });
    await db.transaction(() => saveStore(db, s));
    const objects = new Map();
    const api = await apiForTest(
      t,
      {},
      {
        storageHandler: (req, res) => {
          const url = new URL(req.url, "http://storage");
          if (url.searchParams.has("location")) {
            res.writeHead(200, { "content-type": "application/xml" });
            res.end("<LocationConstraint></LocationConstraint>");
            return;
          }
          if (req.method === "PUT") {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
              objects.set(url.pathname, Buffer.concat(chunks));
              res.writeHead(200, { ETag: '"fixture"' });
              res.end();
            });
            return;
          }
          if (req.method === "HEAD" && url.pathname === "/reschedule-test") {
            res.writeHead(200);
            res.end();
            return;
          }
          const bytes = objects.get(url.pathname) || Buffer.alloc(100);
          res.writeHead(200, {
            "Content-Length": bytes.length,
            "Content-Type": "audio/mp4",
            ETag: '"fixture"',
          });
          res.end(req.method === "HEAD" ? undefined : bytes);
        },
      },
    );
    assert.equal((await api(null, "GET", "/me/product-templates")).status, 401);
    assert.equal(
      (await api("client", "GET", "/me/product-templates")).status,
      403,
    );
    const catalogue = await api(
      "supplier",
      "GET",
      "/me/product-templates?q=flyer",
    );
    assert.equal(catalogue.status, 200);
    assert.equal(catalogue.body.templates.length, 1);
    const tpl = catalogue.body.templates[0];
    const body = {
      templateId: tpl.id,
      supplierServiceId: "service_supplier",
      readyTime: "same_day",
      prices: [{ optionKey: "standard", priceMinor: 1234 }],
    };
    assert.equal(
      (
        await api("supplier", "POST", "/me/template-products", {
          ...body,
          prices: [{ optionKey: "standard", priceMinor: 0 }],
        })
      ).status,
      400,
    );
    const preview = await api(
      "supplier",
      "POST",
      "/me/template-products/preview",
      body,
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.scheduling);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM supplier_catalog_items"))
        .rows[0].n,
      2,
    );
    const created = await api(
      "supplier",
      "POST",
      "/me/template-products",
      body,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const item = created.body.item;
    const pending = await api("ops", "GET", "/ops/catalog-reviews");
    assert.ok(
      pending.body.items.some((i) => i.id === item.id && i.template.priceCheck),
    );
    const approved = await api(
      "ops",
      "POST",
      `/ops/catalog-reviews/${item.id}/decision`,
      { expectedVersion: item.version, status: "approved" },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const visible = await api("client", "GET", `/catalog/items/${item.id}`);
    assert.equal(visible.status, 200);
    assert.ok(visible.body.item.photos[0].downloadUrl);
    assert.match(
      visible.body.item.photos[0].downloadUrl,
      /reference\/product-templates\/.*X-Amz-/,
    );
    await db.transaction(async () => {
      const current = await loadStore(db),
        record = current.catalogItems.find((i) => i.id === item.id);
      const option = current.catalogOptions.find(
        (o) => o.optionGroupId === record.templateData.groupId,
      );
      const snapshot = createOrderLineSnapshot(
        current,
        {
          orderId: "order",
          catalogItemId: record.id,
          optionIds: [option.id],
          expectedVersion: record.version,
          expectedServiceVersion: 1,
          quantity: 2,
          sortOrder: 1,
          createdAt: record.createdAt,
        },
        id,
      );
      current.orderLineItems.push(snapshot.lineItem);
      current.orderLineItemOptions.push(...snapshot.options);
      await saveStore(db, current);
    });
    const changed = await api(
      "supplier",
      "PUT",
      `/me/template-products/${item.id}`,
      {
        ...body,
        expectedVersion: approved.body.item.version,
        prices: [{ optionKey: "standard", priceMinor: 2000 }],
      },
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const priceReview = await api(
      "ops",
      "POST",
      `/ops/catalog-reviews/${item.id}/decision`,
      { expectedVersion: changed.body.item.version, status: "approved" },
    );
    assert.equal(priceReview.status, 200, JSON.stringify(priceReview.body));
    assert.equal(
      (
        await db.query(
          "SELECT effective_unit_price_minor FROM order_line_items WHERE source_catalog_item_id=$1",
          [item.id],
        )
      ).rows[0].effective_unit_price_minor,
      1234,
    );
    const apparel = s.productTemplates.find(
      (t) => t.id === "tpl_custom_apparel",
    );
    const many = await api("supplier", "POST", "/me/template-products", {
      templateId: apparel.id,
      supplierServiceId: "service_apparel",
      readyTime: "4_7_days",
      prices: apparel.options.map((o) => ({
        optionKey: o.key,
        priceMinor: 15000,
      })),
    });
    assert.equal(many.status, 201, JSON.stringify(many.body));
    assert.equal(many.body.item.optionGroups[0].options.length, 180);
    const upload = new FormData();
    upload.set("purpose", "product_setup");
    upload.set(
      "file",
      new Blob(
        [
          Buffer.from(
            "00000018667479704d344120000000006d70343200000000",
            "hex",
          ),
        ],
        { type: "audio/mp4" },
      ),
      "prices.m4a",
    );
    const audio = await api("supplier", "POST", "/files", upload);
    assert.equal(audio.status, 201, JSON.stringify(audio.body));
    assert.equal(
      (await api("replacement", "GET", `/files/${audio.body.file.fileId}`))
        .status,
      403,
    );
    assert.equal(
      (await api("ops", "GET", `/files/${audio.body.file.fileId}`)).status,
      200,
    );
    const req = await api("supplier", "POST", "/me/product-setup-requests", {
      kind: "setup",
      message: "Please prepare products.",
      fileIds: [audio.body.file.fileId],
    });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(
      (await api("replacement", "GET", "/me/product-setup-requests")).body
        .requests.length,
      0,
    );
    const loaded = await loadStore(db);
    assert.equal(
      loaded.catalogItems.find((i) => i.id === item.id).templateData.templateId,
      tpl.id,
    );
    assert.equal(loaded.productSetupRequests.length, 1);
    // Historical adapters omit the additive column on both INSERT and UPDATE.
    const columns = (
      await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='supplier_catalog_items' AND column_name NOT IN ('template_data','search_tsv') ORDER BY ordinal_position",
      )
    ).rows.map((r) => r.column_name);
    const names = columns.map((c) => '"' + c + '"').join(",");
    await db.query(
      `INSERT INTO supplier_catalog_items (${names}) SELECT ${names} FROM supplier_catalog_items WHERE id=$1 ON CONFLICT (id) DO UPDATE SET active=false,version=supplier_catalog_items.version+1`,
      [item.id],
    );
    assert.equal(
      (await loadStore(db)).catalogItems.find((i) => i.id === item.id)
        .templateData.templateId,
      tpl.id,
    );
    const hidden = await api("client", "GET", `/catalog/items/${item.id}`);
    assert.equal(hidden.status, 404);
  },
);
