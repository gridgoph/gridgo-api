import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogItemsWithPhotos,
  decorateCatalogPhotoUrls,
} from "../src/catalog-photo-urls.js";

test("catalogItemsWithPhotos walks match listings and cart line listings", () => {
  const listing = { id: "sci_a", photos: [{ fileId: "file_a" }] };
  const cartListing = { id: "sci_b", photos: [{ fileId: "file_b" }] };
  const collected = catalogItemsWithPhotos({
    listings: [listing],
    cart: { lines: [{ listing: cartListing }, { listing: { id: "stub" } }] },
  });
  assert.deepEqual(collected.map((item) => item.id), ["sci_a", "sci_b"]);
});

test("catalogItemsWithPhotos walks a shop board's service items", () => {
  const collected = catalogItemsWithPhotos({
    shop: {
      supplierId: "user_lovis_printshop",
      services: [
        {
          id: "svc",
          items: [
            { id: "sci_flyers", photos: [{ fileId: "file_flyers" }] },
            { id: "sci_empty" },
          ],
        },
      ],
    },
  });
  assert.deepEqual(collected.map((item) => item.id), ["sci_flyers"]);
});

test("decorateCatalogPhotoUrls signs match listing photos without re-hydrating shops", async () => {
  const store = {
    files: [
      { fileId: "file_quickprint_flyers", objectKey: "dev/davao_quickprint/lst_flyers.jpg" },
    ],
  };
  const body = {
    shop: { supplierId: "user_davao_quickprint", shopName: "Davao Quickprint" },
    listings: [
      {
        id: "sci_davao_quickprint_flyers",
        name: "Flyers",
        photos: [
          {
            fileId: "file_quickprint_flyers",
            sortOrder: 0,
            altText: "Flyers",
            url: "/catalog/media/file_quickprint_flyers",
          },
        ],
      },
    ],
  };

  await decorateCatalogPhotoUrls(store, body, {
    findFile: (s, fileId) => s.files.find((row) => row.fileId === fileId),
    presignGet: async (key) => ({
      url: `https://signed.example/${key}?sig=1`,
      expiresAt: "2026-08-24T22:00:00.000Z",
    }),
  });

  const photo = body.listings[0].photos[0];
  assert.equal(photo.downloadUrl, "https://signed.example/dev/davao_quickprint/lst_flyers.jpg?sig=1");
  assert.equal(photo.downloadUrlExpiresAt, "2026-08-24T22:00:00.000Z");
  // Metadata url stays; clients must not treat it as image bytes.
  assert.equal(photo.url, "/catalog/media/file_quickprint_flyers");
});

test("decorateCatalogPhotoUrls keeps fileId when signing fails", async () => {
  const store = {
    files: [{ fileId: "file_a", objectKey: "missing.jpg" }],
  };
  const body = {
    listings: [{ id: "sci_a", photos: [{ fileId: "file_a", url: "/catalog/media/file_a" }] }],
  };
  await decorateCatalogPhotoUrls(store, body, {
    findFile: (s, fileId) => s.files.find((row) => row.fileId === fileId),
    presignGet: async () => {
      throw new Error("storage unavailable");
    },
  });
  assert.equal(body.listings[0].photos[0].downloadUrl, undefined);
  assert.equal(body.listings[0].photos[0].fileId, "file_a");
});
