export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_profiles
      ADD COLUMN is_closed boolean NOT NULL DEFAULT false;

    CREATE TABLE client_match_preferences (
      client_id text PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      ranking text[] NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_at timestamptz NOT NULL,
      CONSTRAINT client_match_preferences_ranking_check CHECK (
        cardinality(ranking) = 3
        AND ranking @> ARRAY['quality','speed','distance']::text[]
        AND ranking <@ ARRAY['quality','speed','distance']::text[]
      )
    );

    CREATE TABLE client_saved_addresses (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 80),
      address_line text NOT NULL CHECK (btrim(address_line) <> '' AND char_length(address_line) <= 240),
      lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
      lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
      is_default boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX client_saved_addresses_client_idx
      ON client_saved_addresses (client_id, created_at, id);
    CREATE UNIQUE INDEX client_saved_addresses_one_default_idx
      ON client_saved_addresses (client_id) WHERE is_default;

    CREATE TABLE client_carts (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','checked_out')),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      service_level text NOT NULL DEFAULT 'standard' CHECK (service_level IN ('standard','scheduled')),
      scheduled_for timestamptz,
      fulfillment_mode text NOT NULL DEFAULT 'delivery' CHECK (fulfillment_mode IN ('delivery','pickup')),
      default_dropoff_lat double precision CHECK (default_dropoff_lat BETWEEN -90 AND 90),
      default_dropoff_lng double precision CHECK (default_dropoff_lng BETWEEN -180 AND 180),
      default_dropoff_label text,
      checked_out_order_id text UNIQUE REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      checked_out_at timestamptz,
      CHECK (
        (service_level = 'standard' AND scheduled_for IS NULL)
        OR (service_level = 'scheduled' AND scheduled_for IS NOT NULL)
      ),
      CHECK (
        (default_dropoff_lat IS NULL AND default_dropoff_lng IS NULL AND default_dropoff_label IS NULL)
        OR (default_dropoff_lat IS NOT NULL AND default_dropoff_lng IS NOT NULL
          AND default_dropoff_label IS NOT NULL AND btrim(default_dropoff_label) <> '')
      ),
      CHECK (
        (state = 'draft' AND checked_out_order_id IS NULL AND checked_out_at IS NULL)
        OR (state = 'checked_out' AND checked_out_order_id IS NOT NULL AND checked_out_at IS NOT NULL)
      )
    );
    CREATE INDEX client_carts_client_state_idx
      ON client_carts (client_id, state, updated_at DESC);

    CREATE TABLE client_cart_lines (
      id text PRIMARY KEY,
      cart_id text NOT NULL REFERENCES client_carts(id) ON UPDATE CASCADE ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      option_ids text[] NOT NULL DEFAULT '{}',
      quantity integer NOT NULL CHECK (quantity > 0),
      structured_spec jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(structured_spec) = 'object'),
      artwork_file_id text REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      mockup_file_id text REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      dropoff_lat double precision CHECK (dropoff_lat BETWEEN -90 AND 90),
      dropoff_lng double precision CHECK (dropoff_lng BETWEEN -180 AND 180),
      dropoff_label text,
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (cart_id, sort_order),
      CHECK (
        (dropoff_lat IS NULL AND dropoff_lng IS NULL AND dropoff_label IS NULL)
        OR (dropoff_lat IS NOT NULL AND dropoff_lng IS NOT NULL
          AND dropoff_label IS NOT NULL AND btrim(dropoff_label) <> '')
      )
    );
    CREATE INDEX client_cart_lines_cart_supplier_idx
      ON client_cart_lines (cart_id, supplier_id, sort_order);

    CREATE TABLE order_jobs (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rider_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      state text NOT NULL CHECK (state IN (
        'needs_qa','client_correction','approved_for_production','production',
        'supplier_self_qc','ready_for_dispatch','rider_assigned','picked_up',
        'out_for_delivery','delivered','issue_window_open','completed','cancelled'
      )),
      fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('delivery','pickup')),
      pickup_lat double precision NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
      pickup_lng double precision NOT NULL CHECK (pickup_lng BETWEEN -180 AND 180),
      pickup_label text NOT NULL CHECK (btrim(pickup_label) <> ''),
      dropoff_lat double precision CHECK (dropoff_lat BETWEEN -90 AND 90),
      dropoff_lng double precision CHECK (dropoff_lng BETWEEN -180 AND 180),
      dropoff_label text,
      supplier_subtotal_minor money_minor NOT NULL CHECK (supplier_subtotal_minor >= 0),
      delivery_distance_meters integer NOT NULL DEFAULT 0 CHECK (delivery_distance_meters >= 0),
      delivery_fee_minor money_minor NOT NULL CHECK (delivery_fee_minor >= 0),
      estimated_hours integer NOT NULL CHECK (estimated_hours > 0),
      scheduled_for timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (order_id, supplier_id),
      CHECK (
        (fulfillment_mode = 'pickup' AND dropoff_lat IS NULL AND dropoff_lng IS NULL AND dropoff_label IS NULL
          AND delivery_distance_meters = 0 AND delivery_fee_minor = 0)
        OR (fulfillment_mode = 'delivery' AND dropoff_lat IS NOT NULL AND dropoff_lng IS NOT NULL
          AND dropoff_label IS NOT NULL AND btrim(dropoff_label) <> '')
      )
    );
    CREATE INDEX order_jobs_supplier_queue_idx
      ON order_jobs (supplier_id, state, created_at, id);
    CREATE INDEX order_jobs_order_idx ON order_jobs (order_id, id);

    ALTER TABLE order_line_items
      ADD COLUMN job_id text REFERENCES order_jobs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      ADD COLUMN artwork_file_id text REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      ADD COLUMN mockup_file_id text REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      ADD COLUMN dropoff_lat double precision CHECK (dropoff_lat BETWEEN -90 AND 90),
      ADD COLUMN dropoff_lng double precision CHECK (dropoff_lng BETWEEN -180 AND 180),
      ADD COLUMN dropoff_label text,
      ADD CONSTRAINT order_line_items_dropoff_shape_check CHECK (
        (dropoff_lat IS NULL AND dropoff_lng IS NULL AND dropoff_label IS NULL)
        OR (dropoff_lat IS NOT NULL AND dropoff_lng IS NOT NULL
          AND dropoff_label IS NOT NULL AND btrim(dropoff_label) <> '')
      );
    CREATE INDEX order_line_items_job_idx ON order_line_items (job_id, sort_order);

    CREATE FUNCTION preserve_order_line_match_snapshot()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized = true AND ROW(
        NEW.job_id, NEW.artwork_file_id, NEW.mockup_file_id,
        NEW.dropoff_lat, NEW.dropoff_lng, NEW.dropoff_label
      ) IS DISTINCT FROM ROW(
        OLD.job_id, OLD.artwork_file_id, OLD.mockup_file_id,
        OLD.dropoff_lat, OLD.dropoff_lng, OLD.dropoff_label
      ) THEN
        RAISE EXCEPTION 'order line match snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER order_line_items_match_immutable_trigger
      BEFORE UPDATE ON order_line_items FOR EACH ROW
      EXECUTE FUNCTION preserve_order_line_match_snapshot();

    CREATE TABLE job_qa_checklist (
      id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES order_jobs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      code text NOT NULL CHECK (btrim(code) <> ''),
      label text NOT NULL CHECK (btrim(label) <> ''),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed')),
      note text,
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      checked_at timestamptz,
      checked_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (job_id, code),
      UNIQUE (job_id, sort_order)
    );

    CREATE TABLE order_invoices (
      order_id text PRIMARY KEY REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      invoice_number text NOT NULL UNIQUE CHECK (btrim(invoice_number) <> ''),
      issued_at timestamptz NOT NULL,
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
    );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE order_invoices;
    DROP TABLE job_qa_checklist;
    DROP TRIGGER order_line_items_match_immutable_trigger ON order_line_items;
    DROP FUNCTION preserve_order_line_match_snapshot();
    DROP INDEX order_line_items_job_idx;
    ALTER TABLE order_line_items
      DROP CONSTRAINT order_line_items_dropoff_shape_check,
      DROP COLUMN dropoff_label,
      DROP COLUMN dropoff_lng,
      DROP COLUMN dropoff_lat,
      DROP COLUMN mockup_file_id,
      DROP COLUMN artwork_file_id,
      DROP COLUMN job_id;
    DROP TABLE order_jobs;
    DROP TABLE client_cart_lines;
    DROP TABLE client_carts;
    DROP TABLE client_saved_addresses;
    DROP TABLE client_match_preferences;
    ALTER TABLE supplier_profiles DROP COLUMN is_closed;
  `);
}

