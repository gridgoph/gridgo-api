/** Home-only partner promotions. No production promotion data is seeded. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE home_promotions (
      id text PRIMARY KEY,
      name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
      logo_file_id text NOT NULL REFERENCES files(file_id),
      image_file_id text REFERENCES files(file_id),
      description text NOT NULL CHECK (char_length(description) <= 140),
      tag text NOT NULL CHECK (tag IN ('partner','sponsored','featured_shop')),
      link_text text NOT NULL CHECK (char_length(btrim(link_text)) BETWEEN 1 AND 80),
      link_url text NOT NULL CHECK (link_url ~ '^https://'),
      tap_action text NOT NULL DEFAULT 'sheet' CHECK (tap_action IN ('sheet','link')),
      style text NOT NULL CHECK (style IN ('light','yellow')),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz CHECK (ends_at > starts_at),
      enabled boolean NOT NULL DEFAULT false,
      display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      removed_at timestamptz
    );
    CREATE INDEX home_promotions_feed_idx ON home_promotions(display_order, starts_at, id)
      WHERE enabled AND removed_at IS NULL;
    CREATE TABLE home_promotion_daily_stats (
      promotion_id text NOT NULL REFERENCES home_promotions(id),
      day date NOT NULL,
      views bigint NOT NULL DEFAULT 0 CHECK (views BETWEEN 0 AND 9007199254740991),
      opens bigint NOT NULL DEFAULT 0 CHECK (opens BETWEEN 0 AND 9007199254740991),
      taps bigint NOT NULL DEFAULT 0 CHECK (taps BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY (promotion_id, day)
    );
    CREATE TABLE home_promotion_view_sessions (
      promotion_id text NOT NULL REFERENCES home_promotions(id),
      day date NOT NULL,
      session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY (promotion_id, day, session_hash)
    );
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message','pickup_chat_message',
      'client_shop_chat_message','quote_request','home_promotion'
    ));
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
