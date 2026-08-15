export async function up(pgm) {
  pgm.sql(`
    CREATE DOMAIN money_minor AS bigint
      CHECK (VALUE BETWEEN -9007199254740991 AND 9007199254740991);

    CREATE TABLE platform_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      version integer NOT NULL CHECK (version > 0),
      settings jsonb NOT NULL
    );

    CREATE TABLE users (
      id text PRIMARY KEY,
      clerk_user_id text NOT NULL UNIQUE,
      email text NOT NULL,
      name text NOT NULL,
      phone text,
      role text NOT NULL CHECK (role IN ('client', 'supplier', 'rider', 'ops_admin', 'super_admin')),
      account_type text CHECK (account_type IN ('individual', 'business', 'organization')),
      org_name text,
      verification_status text CHECK (verification_status IN ('unverified', 'pending', 'approved', 'rejected', 'suspended')),
      shop_lat double precision CHECK (shop_lat BETWEEN -90 AND 90),
      shop_lng double precision CHECK (shop_lng BETWEEN -180 AND 180),
      shop_label text,
      created_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      CHECK (btrim(id) <> '' AND btrim(clerk_user_id) <> ''),
      CHECK (btrim(email) <> '' AND btrim(name) <> ''),
      CHECK ((role = 'client') = (account_type IS NOT NULL)),
      CHECK ((role IN ('supplier', 'rider')) = (verification_status IS NOT NULL)),
      CHECK ((account_type IN ('business', 'organization')) = (org_name IS NOT NULL)),
      CHECK (role = 'client' OR org_name IS NULL),
      CHECK (org_name IS NULL OR btrim(org_name) <> ''),
      CHECK (
        (shop_lat IS NULL AND shop_lng IS NULL AND shop_label IS NULL)
        OR (role = 'supplier' AND shop_lat IS NOT NULL AND shop_lng IS NOT NULL AND shop_label IS NOT NULL AND btrim(shop_label) <> '')
      )
    );
    CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email));
    CREATE INDEX users_role_verification_idx ON users (role, verification_status);

    CREATE TABLE administrator_bootstrap (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      completed_at timestamptz NOT NULL,
      administrator_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE catalog_products (
      id text PRIMARY KEY,
      name text NOT NULL,
      family text NOT NULL,
      base_price_minor money_minor NOT NULL CHECK (base_price_minor >= 0),
      unit text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );

    CREATE TABLE taxonomy_categories (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      active boolean NOT NULL,
      sort_order integer NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX taxonomy_categories_active_sort_idx ON taxonomy_categories (active, sort_order);

    CREATE TABLE taxonomy_category_aliases (
      code text PRIMARY KEY,
      category_code text NOT NULL REFERENCES taxonomy_categories(code) ON UPDATE CASCADE ON DELETE RESTRICT,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );

    CREATE TABLE taxonomy_subcategories (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      category_code text NOT NULL REFERENCES taxonomy_categories(code) ON UPDATE CASCADE ON DELETE RESTRICT,
      name text NOT NULL,
      active boolean NOT NULL,
      sort_order integer NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX taxonomy_subcategories_parent_idx ON taxonomy_subcategories (category_code, active, sort_order);

    CREATE TABLE taxonomy_materials (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      category_codes text[] NOT NULL,
      active boolean NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX taxonomy_materials_categories_gin_idx ON taxonomy_materials USING gin (category_codes);

    CREATE TABLE taxonomy_finishes (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      category_codes text[] NOT NULL,
      active boolean NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX taxonomy_finishes_categories_gin_idx ON taxonomy_finishes USING gin (category_codes);

    CREATE TABLE zones (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      active boolean NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX zones_active_code_idx ON zones (active, code);

    CREATE TABLE supplier_services (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      category_code text NOT NULL,
      state text NOT NULL CHECK (state IN ('draft', 'pending_verification', 'live', 'suspended', 'withdrawn')),
      reference_rate_minor money_minor NOT NULL CHECK (reference_rate_minor >= 0),
      turnaround_hours integer NOT NULL CHECK (turnaround_hours > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX supplier_services_matching_idx ON supplier_services (category_code, state, supplier_id);

    CREATE TABLE orders (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      supplier_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rider_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      product_id text REFERENCES catalog_products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      state text NOT NULL CHECK (state IN (
        'draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval',
        'approved_for_matching', 'supplier_assigned', 'awaiting_downpayment',
        'downpayment_review', 'payment_authorized', 'production', 'supplier_self_qc',
        'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery',
        'delivered', 'issue_window_open', 'completed', 'payout_released'
      )),
      zone_code text REFERENCES zones(code) ON UPDATE CASCADE ON DELETE RESTRICT,
      supplier_price_minor money_minor,
      commission_minor money_minor,
      subtotal_minor money_minor,
      delivery_fee_minor money_minor,
      total_minor money_minor,
      downpayment_minor money_minor,
      balance_minor money_minor,
      payout_hold boolean NOT NULL DEFAULT false,
      pickup_lat double precision CHECK (pickup_lat BETWEEN -90 AND 90),
      pickup_lng double precision CHECK (pickup_lng BETWEEN -180 AND 180),
      pickup_label text,
      dropoff_lat double precision NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
      dropoff_lng double precision NOT NULL CHECK (dropoff_lng BETWEEN -180 AND 180),
      dropoff_label text NOT NULL,
      issue_window_opened_at timestamptz,
      issue_window_expires_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      CHECK (
        (pickup_lat IS NULL AND pickup_lng IS NULL AND pickup_label IS NULL)
        OR (pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL AND pickup_label IS NOT NULL AND btrim(pickup_label) <> '')
      ),
      CHECK (btrim(dropoff_label) <> ''),
      CHECK (supplier_price_minor IS NULL OR supplier_price_minor >= 0),
      CHECK (commission_minor IS NULL OR commission_minor >= 0),
      CHECK (subtotal_minor IS NULL OR subtotal_minor >= 0),
      CHECK (delivery_fee_minor IS NULL OR delivery_fee_minor >= 0),
      CHECK (total_minor IS NULL OR total_minor >= 0),
      CHECK (downpayment_minor IS NULL OR downpayment_minor >= 0),
      CHECK (balance_minor IS NULL OR balance_minor >= 0),
      CHECK (supplier_price_minor IS NULL OR commission_minor IS NULL OR subtotal_minor = supplier_price_minor + commission_minor),
      CHECK (subtotal_minor IS NULL OR delivery_fee_minor IS NULL OR total_minor = subtotal_minor + delivery_fee_minor),
      CHECK (downpayment_minor IS NULL OR balance_minor IS NULL OR total_minor = downpayment_minor + balance_minor)
    );
    CREATE INDEX orders_client_state_idx ON orders (client_id, state, updated_at DESC);
    CREATE INDEX orders_supplier_state_idx ON orders (supplier_id, state, updated_at DESC);
    CREATE INDEX orders_rider_state_idx ON orders (rider_id, state, updated_at DESC);
    CREATE INDEX orders_dispatch_state_idx ON orders (state, updated_at DESC);
    CREATE INDEX orders_issue_expiry_idx ON orders (issue_window_expires_at)
      WHERE state = 'issue_window_open';

    CREATE TABLE order_payments (
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      code text NOT NULL CHECK (code IN ('downpayment', 'balance')),
      amount_minor money_minor CHECK (amount_minor >= 0),
      method text NOT NULL CHECK (method = 'qr_manual'),
      status text NOT NULL CHECK (status IN ('not_submitted', 'pending_confirmation', 'confirmed')),
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY (order_id, code)
    );
    CREATE INDEX order_payments_status_idx ON order_payments (status, order_id);

    CREATE TABLE payout_milestones (
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      code text NOT NULL CHECK (code IN ('printing', 'packaging_qc', 'delivered', 'retention')),
      share_percent integer NOT NULL CHECK (share_percent BETWEEN 0 AND 100),
      amount_minor money_minor NOT NULL CHECK (amount_minor >= 0),
      status text NOT NULL CHECK (status IN ('pending_pof', 'pof_attached', 'released')),
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY (order_id, code)
    );
    CREATE INDEX payout_milestones_release_idx ON payout_milestones (order_id, status);

    CREATE TABLE files (
      file_id text PRIMARY KEY,
      owner_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      purpose text NOT NULL,
      original_filename text NOT NULL,
      declared_content_type text NOT NULL,
      detected_content_type text,
      size_bytes bigint CHECK (size_bytes >= 0),
      state text NOT NULL CHECK (state IN ('pending_upload', 'ready', 'delete_pending', 'deleted')),
      object_key text UNIQUE,
      created_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      CHECK ((state = 'deleted') = (object_key IS NULL))
    );
    CREATE INDEX files_owner_state_idx ON files (owner_id, state, created_at DESC);

    CREATE TABLE file_references (
      file_id text NOT NULL REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE CASCADE,
      reference_type text NOT NULL CHECK (reference_type IN ('order', 'supplier_service', 'user')),
      reference_id text NOT NULL,
      field text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY (file_id, reference_type, reference_id, field)
    );
    CREATE INDEX file_references_target_idx ON file_references (reference_type, reference_id);

    CREATE TABLE credit_accounts (
      user_id text PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      balance_minor money_minor NOT NULL DEFAULT 0,
      data jsonb NOT NULL DEFAULT '{}'
    );

    CREATE TABLE credit_ledger (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES credit_accounts(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
      amount_minor money_minor NOT NULL,
      balance_after_minor money_minor NOT NULL,
      created_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX credit_ledger_user_time_idx ON credit_ledger (user_id, created_at DESC);

    CREATE TABLE claims (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('open', 'payout_held', 'released', 'resolved')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX claims_order_status_idx ON claims (order_id, status, updated_at DESC);

    CREATE TABLE issues (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      client_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      claim_id text UNIQUE REFERENCES claims(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind text NOT NULL,
      status text NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX issues_order_status_idx ON issues (order_id, status, updated_at DESC);

    CREATE TABLE audit_log (
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      actor_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      actor_role text,
      action text NOT NULL,
      entity_type text,
      entity_id text,
      order_id text REFERENCES orders(id) ON UPDATE CASCADE ON DELETE SET NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX audit_log_time_idx ON audit_log (at DESC);
    CREATE INDEX audit_log_order_idx ON audit_log (order_id, at DESC);

    CREATE TABLE notifications (
      id text PRIMARY KEY,
      sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      type text NOT NULL,
      order_id text REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      created_at timestamptz NOT NULL,
      read_at timestamptz,
      deleted_at timestamptz,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX notifications_snapshot_idx ON notifications (user_id, deleted_at, sequence DESC);

    CREATE TABLE location_pings (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
      lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
      accuracy_meters double precision CHECK (accuracy_meters >= 0),
      at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX location_pings_latest_idx ON location_pings (order_id, at DESC);

    CREATE TABLE escalations (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rider_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('open', 'resolved')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX escalations_status_time_idx ON escalations (status, created_at DESC);

    CREATE TABLE proofs (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      uploader_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX proofs_order_time_idx ON proofs (order_id, created_at DESC);

    CREATE TABLE device_tokens (
      id text PRIMARY KEY,
      user_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      platform text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX device_tokens_owner_idx ON device_tokens (user_id, updated_at DESC);
    CREATE INDEX device_tokens_unclaimed_idx ON device_tokens (updated_at) WHERE user_id IS NULL;
  `);
}

export const down = false;
