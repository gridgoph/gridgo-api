/** Separate customer and shop consent without changing existing grant facts. */
export const up = pgm => pgm.sql(`
  ALTER TABLE early_access_signups
    ADD COLUMN app text NOT NULL DEFAULT 'customer' CHECK (app IN ('customer','shop')),
    ADD COLUMN shop_name text CHECK (shop_name IS NULL OR
      (app='shop' AND shop_name=btrim(shop_name) AND char_length(shop_name) BETWEEN 1 AND 80
        AND shop_name !~ '[[:cntrl:]]')),
    DROP CONSTRAINT early_access_signups_email_key,
    ADD CONSTRAINT early_access_signups_email_app_key UNIQUE(email,app),
    ADD CONSTRAINT early_access_shop_android_only CHECK (app<>'shop' OR platform='android' OR status='pending');
  CREATE INDEX early_access_app_status_date_idx ON early_access_signups(app,status,created_at DESC,id DESC);
`);
export const down = () => { throw new Error('Per-app early access consent requires a forward migration'); };
