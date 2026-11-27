/** Additive, reviewed shop print prices and new-order detection threshold. */
export async function up(pgm) {
 pgm.sql(`CREATE TABLE supplier_catalog_express_prices (
     catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id) ON DELETE CASCADE,
     paper_size text NOT NULL,
     plan_type text NOT NULL DEFAULT '',
     tier_code text NOT NULL,
     price_minor money_minor NOT NULL CHECK (price_minor > 0 AND price_minor % 100 = 0),
     PRIMARY KEY (catalog_item_id,paper_size,plan_type,tier_code),
     CHECK ((plan_type='' AND paper_size IN ('a4','short','long','a3') AND tier_code IN ('bw','light','full'))
       OR (plan_type='whiteprint' AND paper_size IN ('20x30','24x36','30x40','a2','a1','a0') AND tier_code IN ('bw','colour'))
       OR (plan_type IN ('blue_ink','blue_paper') AND paper_size IN ('20x30','24x36','30x40','a2','a1','a0') AND tier_code='blue'))
   );
   UPDATE platform_settings SET settings=settings || '{"expressLightColourMaxBps":2500}'::jsonb,version=version+1
     WHERE NOT settings ? 'expressLightColourMaxBps';`);
}
export async function down(){throw new Error('Use a forward migration; retain accepted Express price evidence.');}
