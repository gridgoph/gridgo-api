/** Optional pricing survey answers and the once-a-week checkout exit question. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE order_surveys
      ADD COLUMN direct_shop_comparison text CHECK (direct_shop_comparison IN
        ('much_cheaper','cheaper','about_the_same','more_expensive','much_more_expensive','not_sure')),
      ADD COLUMN price_worth_tags jsonb NOT NULL DEFAULT '[]'
        CHECK (jsonb_typeof(price_worth_tags) = 'array' AND jsonb_array_length(price_worth_tags) <= 10),
      ADD COLUMN order_again_at_price text CHECK (order_again_at_price IN ('yes','maybe','no'));

    -- Mutable marker: the client opened checkout for this cart. Snapshots feed report filters.
    CREATE TABLE checkout_visits (
      cart_id text PRIMARY KEY REFERENCES client_carts(id),
      client_id text NOT NULL REFERENCES users(id),
      first_reached_at timestamptz NOT NULL,
      last_reached_at timestamptz NOT NULL CHECK (last_reached_at >= first_reached_at),
      cart_total_minor money_minor CHECK (cart_total_minor >= 0),
      category_codes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(category_codes) = 'array' AND jsonb_array_length(category_codes) <= 50)
    );
    CREATE INDEX checkout_visits_client_idx ON checkout_visits(client_id, last_reached_at DESC);

    CREATE TABLE checkout_exit_prompts (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id),
      cart_id text NOT NULL,
      reached_at timestamptz NOT NULL,
      asked_at timestamptz NOT NULL CHECK (asked_at >= reached_at),
      cart_total_minor money_minor CHECK (cart_total_minor >= 0),
      category_codes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(category_codes) = 'array' AND jsonb_array_length(category_codes) <= 50),
      answered_at timestamptz CHECK (answered_at >= asked_at),
      skipped_at timestamptz CHECK (skipped_at >= asked_at),
      reason text CHECK (reason IN ('price_too_high','delivery_cost_or_time','still_deciding','payment_problem','found_another_option','just_browsing','other')),
      other_text text CHECK (length(other_text) BETWEEN 1 AND 500),
      CHECK (answered_at IS NULL OR skipped_at IS NULL),
      CHECK ((answered_at IS NULL) = (reason IS NULL)),
      CHECK (other_text IS NULL OR reason = 'other'),
      CHECK (reason IS DISTINCT FROM 'other' OR other_text IS NOT NULL)
    );
    CREATE INDEX checkout_exit_prompts_client_idx ON checkout_exit_prompts(client_id, asked_at DESC);
    CREATE INDEX checkout_exit_prompts_admin_idx ON checkout_exit_prompts(asked_at DESC);
    CREATE FUNCTION guard_checkout_exit_prompt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'checkout exit history is immutable' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' AND (OLD.answered_at IS NOT NULL OR OLD.skipped_at IS NOT NULL OR
        ROW(OLD.id,OLD.client_id,OLD.cart_id,OLD.reached_at,OLD.asked_at,OLD.cart_total_minor,OLD.category_codes)
        IS DISTINCT FROM ROW(NEW.id,NEW.client_id,NEW.cart_id,NEW.reached_at,NEW.asked_at,NEW.cart_total_minor,NEW.category_codes)) THEN
        RAISE EXCEPTION 'checkout exit facts and answers are immutable' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
        IF EXISTS (SELECT 1 FROM checkout_exit_prompts p WHERE p.client_id=NEW.client_id AND p.id<>NEW.id
          AND p.asked_at > NEW.asked_at - interval '168 hours' AND p.asked_at < NEW.asked_at + interval '168 hours') THEN
          RAISE EXCEPTION 'checkout exit prompt cooldown' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER checkout_exit_prompts_guard BEFORE INSERT OR UPDATE OR DELETE ON checkout_exit_prompts
      FOR EACH ROW EXECUTE FUNCTION guard_checkout_exit_prompt();
  `);
}
export async function down() { throw new Error('Pricing feedback history is forward-only'); }
