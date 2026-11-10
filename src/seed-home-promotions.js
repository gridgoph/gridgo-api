import fs from 'node:fs/promises';
import { loadStore, saveStore } from './postgres-store.js';
import { bindPromotionMedia } from './home-promotions.js';

/** Development only; repeated seeds preserve staff edits and soft removal. */
export async function seedDevelopmentPromotion(database, { objectStorage, now = () => new Date().toISOString(), env = process.env } = {}) {
  if (!['development', 'test'].includes(env.NODE_ENV) || !String(env.CLERK_SECRET_KEY || '').startsWith('sk_test_')) {
    throw new Error('development_seed_not_allowed');
  }
  if (!objectStorage) return false;
  return database.transaction(async () => {
    const promotionId = 'promo_dev_davaogo';
    if ((await database.query('SELECT 1 FROM home_promotions WHERE id=$1', [promotionId])).rowCount) return false;
    const store = await loadStore(database);
    const owner = store.userRoleMemberships.find(m => ['super_admin', 'ops_admin'].includes(m.role));
    if (!owner) return false;
    const bytes = await fs.readFile(new URL('./seed-assets/davaogo-logo.png', import.meta.url));
    const fileId = 'file_dev_davaogo_logo';
    const key = 'development/promotions/davaogo-logo.png';
    await objectStorage.putObject({ key, body: bytes, contentType: 'image/png', size: bytes.length });
    const at = now();
    store.files.push({ fileId, ownerId: owner.userId, purpose: 'promotion_logo', originalFilename: 'davaogo-logo.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', size: bytes.length, state: 'ready', objectKey: key,
      createdAt: at, readyAt: at, references: [] });
    bindPromotionMedia(store, promotionId, { logo: { fileId } }, at);
    await saveStore(database, store);
    await database.query(`INSERT INTO home_promotions(id,name,logo_file_id,description,tag,link_text,link_url,
      tap_action,style,starts_at,enabled,display_order,created_at,updated_at)
      VALUES ($1,'DavaoGo',$2,'Our partner app in Davao. Tap to visit.','partner','Visit DavaoGo',
        'https://davaogo.app/','sheet','yellow',$3,true,1,$3,$3)`, [promotionId, fileId, at]);
    return true;
  });
}
