/**
 * Quote requests (gridgo-api#226): custom signage and 3D printing quoted by
 * Operations from suitable shops, then accepted as a normal order line.
 *
 * A request holds the client's brief. Operations records each shop's reply and
 * publishes up to three of them as anonymous options A/B/C. Publishing makes one
 * private whole-job listing per option at the shop's own price: accepting puts
 * that listing in a fresh cart, so checkout, the service fee, payment, approval
 * proof, production, dispatch, payouts and refunds stay exactly as they are.
 * `quote_request_id` / `quote_client_id` keep those listings out of every
 * catalogue, board and match; only the owning client's cart can price them.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE quote_requests (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status text NOT NULL CONSTRAINT quote_requests_status_check
        CHECK (status IN ('requested', 'quoting', 'published', 'accepted', 'ordered', 'expired', 'cancelled')),
      subcategory_code text NOT NULL,
      quantity integer NOT NULL CONSTRAINT quote_requests_quantity_check CHECK (quantity > 0),
      budget_minor bigint CONSTRAINT quote_requests_budget_check CHECK (budget_minor IS NULL OR budget_minor >= 0),
      event_date date,
      valid_until timestamptz,
      version integer NOT NULL DEFAULT 1 CONSTRAINT quote_requests_version_check CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT quote_requests_validity_check CHECK (status NOT IN ('published', 'accepted') OR valid_until IS NOT NULL)
    );
    CREATE INDEX quote_requests_client_idx ON quote_requests (client_id, created_at DESC);
    CREATE INDEX quote_requests_status_idx ON quote_requests (status, created_at DESC);
    CREATE INDEX quote_requests_due_idx ON quote_requests (valid_until) WHERE status IN ('published', 'accepted');

    CREATE TABLE quote_replies (
      id text PRIMARY KEY,
      quote_request_id text NOT NULL REFERENCES quote_requests(id) ON DELETE RESTRICT,
      supplier_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status text NOT NULL CONSTRAINT quote_replies_status_check CHECK (status IN ('active', 'withdrawn')),
      price_minor bigint NOT NULL CONSTRAINT quote_replies_price_check CHECK (price_minor > 0),
      version integer NOT NULL DEFAULT 1 CONSTRAINT quote_replies_version_check CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX quote_replies_request_idx ON quote_replies (quote_request_id, created_at);

    ALTER TABLE supplier_catalog_items
      ADD COLUMN quote_request_id text REFERENCES quote_requests(id) ON DELETE RESTRICT,
      ADD COLUMN quote_client_id text REFERENCES users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT supplier_catalog_items_quote_check
        CHECK ((quote_request_id IS NULL) = (quote_client_id IS NULL));
    CREATE INDEX supplier_catalog_items_quote_idx ON supplier_catalog_items (quote_request_id) WHERE quote_request_id IS NOT NULL;

    -- A request's reference files stay retained (in use) while the request exists.
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message','pickup_chat_message','client_shop_chat_message','quote_request'
    ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM supplier_catalog_items WHERE quote_request_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Cannot reverse while quote listings exist';
      END IF;
    END $$;
    DELETE FROM file_references WHERE reference_type = 'quote_request';
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message','pickup_chat_message','client_shop_chat_message'
    ));
    ALTER TABLE supplier_catalog_items DROP CONSTRAINT supplier_catalog_items_quote_check,
      DROP COLUMN quote_client_id, DROP COLUMN quote_request_id;
    DROP TABLE quote_replies;
    DROP TABLE quote_requests;
  `);
}
