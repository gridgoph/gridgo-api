/**
 * Attach short-lived signed download URLs to catalog sample photos.
 *
 * Public catalog and match payloads carry photos with `fileId` and a metadata
 * `url` (`/catalog/media/:fileId`). That path is not image bytes — the client
 * needs `downloadUrl` from MinIO. Keep this walk cheap: sign whatever photo
 * stubs are already on the response; do not re-hydrate shops.
 */

function collectShopItems(shop, items) {
  for (const service of shop?.services || []) {
    for (const item of service.items || []) {
      if (item?.photos) items.push(item);
    }
  }
}

/** Catalog items that already carry a photos array on this response body. */
export function catalogItemsWithPhotos(body) {
  const items = [];
  if (body?.item?.photos) items.push(body.item);
  if (Array.isArray(body?.items)) {
    for (const item of body.items) {
      if (item?.photos) items.push(item);
    }
  }
  if (Array.isArray(body?.listings)) {
    for (const item of body.listings) {
      if (item?.photos) items.push(item);
    }
  }
  if (Array.isArray(body?.cart?.lines)) {
    for (const line of body.cart.lines) {
      if (line?.listing?.photos) items.push(line.listing);
    }
  }
  // GET /catalog/shops/:id is `{ shop: { services: [ { items } ] } }`.
  // Without this walk the client category wall gets fileId but no downloadUrl,
  // so every tile reads "No sample".
  if (body?.shop) collectShopItems(body.shop, items);
  if (Array.isArray(body?.shops)) {
    for (const shop of body.shops) collectShopItems(shop, items);
  }
  return items;
}

/**
 * @param {object} store
 * @param {object} body response body that may nest catalog items
 * @param {{ findFile: Function, presignGet: (key: string) => Promise<{ url: string, expiresAt: string }> }} deps
 */
export async function decorateCatalogPhotoUrls(store, body, { findFile, presignGet }) {
  for (const item of catalogItemsWithPhotos(body)) {
    for (const photo of item.photos || []) {
      const file = findFile(store, photo.fileId);
      if (!file?.objectKey) continue;
      try {
        const signed = await presignGet(file.objectKey);
        photo.downloadUrl = signed.url;
        photo.downloadUrlExpiresAt = signed.expiresAt;
      } catch {
        // Keep fileId as the identity even if signing is unavailable.
      }
    }
  }
}
