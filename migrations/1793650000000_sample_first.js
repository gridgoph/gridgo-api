/**
 * Sample First (gridgo-api#222; issue reports 77B52CCC and 4D659BDC).
 *
 * - A shop listing may offer a paid sample at its own price.
 * - A sample is an ordinary order. At checkout the client's intended batch is
 *   kept as a draft linked to that order, with a private immutable copy of the
 *   listing's batch pricing rules (bulk tiers included) as they stood then.
 * - A cart line is either a sample (`sample`) or a batch made from a draft
 *   (`sample_batch_draft_id`, priced `held` or `current`).
 *
 * Nothing existing is rewritten: every listing starts without samples and
 * every cart line is neither a sample nor a batch.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN sample_available boolean NOT NULL DEFAULT false,
      ADD COLUMN sample_price_minor bigint,
      ADD CONSTRAINT supplier_catalog_items_sample_offer_check CHECK (
        (sample_price_minor IS NULL OR sample_price_minor BETWEEN 1 AND 9007199254740991)
        AND (NOT sample_available OR sample_price_minor IS NOT NULL));

    CREATE TABLE sample_batch_drafts (
      id text PRIMARY KEY CHECK (id ~ '^sbd_[A-Za-z0-9_-]{1,96}$'),
      client_id text NOT NULL REFERENCES users(id),
      supplier_id text NOT NULL REFERENCES users(id),
      catalog_item_id text NOT NULL,
      sample_order_id text NOT NULL UNIQUE REFERENCES orders(id),
      batch_order_id text UNIQUE REFERENCES orders(id),
      previous_draft_id text REFERENCES sample_batch_drafts(id),
      status text NOT NULL CHECK (status IN ('awaiting_sample', 'approved', 'rejected', 'cancelled', 'ordered')),
      hold_days integer NOT NULL CHECK (hold_days BETWEEN 1 AND 90),
      sample_delivered_at timestamptz,
      held_until timestamptz,
      batch jsonb NOT NULL CHECK (jsonb_typeof(batch) = 'object'),
      held_pricing jsonb NOT NULL CHECK (jsonb_typeof(held_pricing) = 'object'),
      approval jsonb CHECK (approval IS NULL OR jsonb_typeof(approval) = 'object'),
      rejection jsonb CHECK (rejection IS NULL OR jsonb_typeof(rejection) = 'object'),
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT sample_batch_drafts_batch_link_check CHECK ((status = 'ordered') = (batch_order_id IS NOT NULL)),
      CONSTRAINT sample_batch_drafts_decision_check CHECK (status NOT IN ('approved', 'ordered') OR approval IS NOT NULL),
      CONSTRAINT sample_batch_drafts_hold_window_check CHECK ((held_until IS NULL) = (sample_delivered_at IS NULL)
        AND (held_until IS NULL OR held_until > sample_delivered_at))
    );
    CREATE INDEX sample_batch_drafts_client_idx ON sample_batch_drafts(client_id, created_at DESC);
    CREATE INDEX sample_batch_drafts_supplier_idx ON sample_batch_drafts(supplier_id, created_at DESC);
    CREATE INDEX sample_batch_drafts_status_idx ON sample_batch_drafts(status, created_at DESC);

    -- The held price is the promise: once written, the rules, the intended batch,
    -- the sample it came from and the hold length never change. The hold start,
    -- approval and batch link are written once.
    CREATE FUNCTION sample_batch_drafts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.held_pricing IS DISTINCT FROM OLD.held_pricing OR NEW.batch IS DISTINCT FROM OLD.batch
         OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
         OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id OR NEW.sample_order_id IS DISTINCT FROM OLD.sample_order_id
         OR NEW.hold_days IS DISTINCT FROM OLD.hold_days OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.previous_draft_id IS DISTINCT FROM OLD.previous_draft_id THEN
        RAISE EXCEPTION 'sample batch drafts keep their held pricing and intended batch' USING ERRCODE = 'check_violation';
      END IF;
      IF (OLD.held_until IS NOT NULL AND NEW.held_until IS DISTINCT FROM OLD.held_until)
         OR (OLD.sample_delivered_at IS NOT NULL AND NEW.sample_delivered_at IS DISTINCT FROM OLD.sample_delivered_at)
         OR (OLD.approval IS NOT NULL AND NEW.approval IS DISTINCT FROM OLD.approval)
         OR (OLD.batch_order_id IS NOT NULL AND NEW.batch_order_id IS DISTINCT FROM OLD.batch_order_id) THEN
        RAISE EXCEPTION 'sample batch hold, approval and batch link are written once' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sample_batch_drafts_immutable BEFORE UPDATE ON sample_batch_drafts
      FOR EACH ROW EXECUTE FUNCTION sample_batch_drafts_immutable();

    ALTER TABLE client_cart_lines
      ADD COLUMN sample jsonb CHECK (sample IS NULL OR jsonb_typeof(sample) = 'object'),
      ADD COLUMN sample_batch_draft_id text REFERENCES sample_batch_drafts(id),
      ADD COLUMN sample_batch_pricing text CHECK (sample_batch_pricing IN ('held', 'current')),
      ADD CONSTRAINT client_cart_lines_sample_kind_check CHECK (
        (sample_batch_draft_id IS NULL) = (sample_batch_pricing IS NULL)
        AND (sample IS NULL OR sample_batch_draft_id IS NULL));
    CREATE INDEX client_cart_lines_sample_batch_idx ON client_cart_lines(sample_batch_draft_id) WHERE sample_batch_draft_id IS NOT NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM sample_batch_drafts)
         OR EXISTS (SELECT 1 FROM client_cart_lines WHERE sample IS NOT NULL)
         OR EXISTS (SELECT 1 FROM supplier_catalog_items WHERE sample_available) THEN
        RAISE EXCEPTION 'Cannot reverse while samples are offered, carted or ordered';
      END IF;
    END $$;
    ALTER TABLE client_cart_lines DROP CONSTRAINT client_cart_lines_sample_kind_check,
      DROP COLUMN sample_batch_pricing, DROP COLUMN sample_batch_draft_id, DROP COLUMN sample;
    DROP TABLE sample_batch_drafts;
    DROP FUNCTION sample_batch_drafts_immutable();
    ALTER TABLE supplier_catalog_items DROP CONSTRAINT supplier_catalog_items_sample_offer_check,
      DROP COLUMN sample_price_minor, DROP COLUMN sample_available;
  `);
}
