import { apiForTest } from './reschedule-http.js';
import { setupOrders } from './order-reads.js';
import { saveStore } from '../../src/postgres-store.js';
import { parseColourListing } from '../../src/colour-pricing.js';
import { AT } from './reschedule.js';

export function readParityColourPricing() {
  return { sizes: [
    { paperSize: '36x48', tierSet: 'large_format', prices: { none: 3000, up_to_25: 6000, up_to_50: 10000, above_50: 20000 } },
    { paperSize: '4x8 ft', tierSet: 'large_format', prices: { above_50: 400, none: 200 } },
    { paperSize: 'A3', tierSet: 'a3', prices: { full_colour: 2500, monochrome: 0 } },
    { paperSize: '20x30', tierSet: 'large_format', prices: { none: 1000, up_to_25: 2000, up_to_50: 3000, above_50: 4000 } },
    { paperSize: '8x2 ft', tierSet: 'large_format', prices: { above_50: 800, none: 600 } },
    { paperSize: 'A4', tierSet: 'large_format', prices: { above_50: 500, none: 0 } },
    { paperSize: '2x3.5 in', tierSet: 'large_format', prices: { above_50: 20, none: 10 } },
  ] };
}

export async function setupReadParity(database) {
  const store = await setupOrders(database);
  const item = { ...structuredClone(store.catalogItems.find(row => row.id === 'item_replacement')),
    id: 'item_colour', pricingUnit: 'per_page', printLayouts: ['fit_to_paper'] };
  const entered = readParityColourPricing();
  Object.assign(item, parseColourListing({ pricedByColour: true, colourPricing: entered }, item));
  // Emulate legacy heap insertion order even after new writes canonicalise.
  // Wide, rotated and small sheets distinguish numeric dimensions from text.
  item.colourPricing.sizes = entered.sizes.map(({ paperSize }) => item.colourPricing.sizes.find(size => size.paperSize === paperSize));
  store.catalogItems.push(item);
  store.files.push({ ...structuredClone(store.files.find(row => row.fileId === 'photo_replacement')),
    fileId: 'photo_colour', objectKey: 'private/photo_colour',
    references: [{ type: 'supplier_catalog_item', id: item.id, field: 'photos' }] });
  store.catalogItemPhotos.push({ catalogItemId: item.id, fileId: 'photo_colour', sortOrder: 0, createdAt: AT });

  const order = store.orders.find(row => row.id === 'a_active');
  order.deliveryEvidence = { recordedAt: AT, riderId: 'rider' };
  store.files.push({ ...structuredClone(store.files.find(row => row.fileId === 'art_a_active')),
    fileId: 'file_delivery_package_photo', objectKey: 'private/file_delivery_package_photo',
    purpose: 'delivery_package_photo', ownerId: 'rider', originalFilename: 'package.png',
    declaredContentType: 'image/png', detectedContentType: 'image/png',
    references: [{ type: 'order', id: order.id, field: 'deliveryPackagePhotoFileIds' }] });
  store.deliveryReminders.push({ orderId: order.id, clientId: 'client', riderId: 'rider', deliveredAt: AT,
    protocolVersion: 1, remindedClient: true, clientAgreedToPhoto: true, packagePhotoFileId: 'file_delivery_package_photo' });
  await database.transaction(() => saveStore(database, store));
  return store;
}

// Test-only dispatcher bypass and clock; production has no baseline switch.
export function readParityEnv(full, at) {
  const hook = `
    import { registerHooks } from 'node:module';
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [${at}])); }
      static now() { return ${at}; }
    };
    ${full ? `registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/src/postgres-store.js')) {
        const source = String(result.source).replace(/export function isHotReadPath\\(pathname\\) \\{[^}]+\\}/,
          'export function isHotReadPath() { return false; }');
        if (source === String(result.source)) throw new Error('Full-store baseline was not installed');
        return { ...result, source };
      }
      return result;
    } });` : ''}`;
  // Force plain index scans only in the targeted child, so parity cannot rely
  // on both queries accidentally returning the same physical heap order.
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!full) databaseUrl.searchParams.set('options', '-c enable_seqscan=off -c enable_bitmapscan=off -c jit=off');
  return { DATABASE_URL: databaseUrl.href, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}`, MINIO_PUBLIC_URL: 'https://storage.example.invalid' };
}


// JWT claims must follow the same frozen clock as both API children. Otherwise
// a slow CI run eventually issues nbf values later than the children's clock.
export async function parityApiForTest(t, full, at, options = {}) {
  const api = await apiForTest(t, readParityEnv(full, at), options);
  const seconds = Math.floor(at / 1000);
  return (who, method, path, body, opts = {}) => api(who, method, path, body, {
    ...opts, claims: { iat: seconds - 5, nbf: seconds - 5, exp: seconds + 3600, ...opts.claims },
  });
}
