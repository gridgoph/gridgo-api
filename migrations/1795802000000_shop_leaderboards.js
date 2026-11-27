/** Monthly awards freeze the scoring policy and winning local ranks. Sticker
 * delivery is independent so an Operations action cannot rewrite an award. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE shop_leaderboard_months (
      month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      closed_at timestamptz NOT NULL,
      data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'
        AND jsonb_typeof(data->'winners')='array' AND jsonb_typeof(data->'policy')='object')
    );
    CREATE FUNCTION guard_shop_leaderboard_month() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'monthly shop awards are immutable' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER shop_leaderboard_month_immutable BEFORE UPDATE OR DELETE ON shop_leaderboard_months
      FOR EACH ROW EXECUTE FUNCTION guard_shop_leaderboard_month();
    CREATE TABLE shop_top_stickers (
      month text NOT NULL REFERENCES shop_leaderboard_months(month),
      supplier_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivered_at timestamptz,
      delivered_by text REFERENCES users(id),
      PRIMARY KEY (month,supplier_id),
      CHECK ((delivered_at IS NULL) = (delivered_by IS NULL))
    );
    CREATE FUNCTION guard_shop_top_sticker() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.month IS DISTINCT FROM OLD.month OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
        OR (OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
          OR NEW.delivered_by IS DISTINCT FROM OLD.delivered_by)) THEN
        RAISE EXCEPTION 'sticker award and delivery are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER shop_top_sticker_immutable BEFORE UPDATE ON shop_top_stickers
      FOR EACH ROW EXECUTE FUNCTION guard_shop_top_sticker();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
