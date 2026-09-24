/** Delivery collection stays gross; these snapshots divide its ownership. */
export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings SET settings = settings || '{"riderCommissionBps":8500}'::jsonb
      WHERE NOT settings ? 'riderCommissionBps';
  `);
  for (const table of ["orders", "order_jobs"]) {
    pgm.sql(`
      -- Existing jobs retain the original 100% rider pass-through. Application
      -- creation paths explicitly snapshot the current setting for new jobs.
      ALTER TABLE ${table}
        ADD COLUMN rider_commission_bps integer NOT NULL DEFAULT 10000
          CHECK (rider_commission_bps BETWEEN 0 AND 10000),
        ADD COLUMN rider_payout_minor bigint GENERATED ALWAYS AS
          (floor((delivery_fee_minor::numeric * rider_commission_bps + 5000) / 10000)::bigint) STORED,
        ADD COLUMN platform_delivery_share_minor bigint GENERATED ALWAYS AS
          (delivery_fee_minor - floor((delivery_fee_minor::numeric * rider_commission_bps + 5000) / 10000)::bigint) STORED;
    `);
  }
  pgm.sql(`
    CREATE FUNCTION protect_order_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- The existing money trigger separately guards the only allowed quote
      -- supersession path. A newly accepted replacement takes a fresh rate.
      IF OLD.commercial_committed_at IS NOT NULL AND NEW.commercial_committed_at IS NOT NULL
         AND NEW.rider_commission_bps IS DISTINCT FROM OLD.rider_commission_bps THEN
        RAISE EXCEPTION 'committed delivery split is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_delivery_snapshot_immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER orders_delivery_snapshot_trigger BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION protect_order_delivery_snapshot();

    CREATE FUNCTION protect_job_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.rider_commission_bps IS DISTINCT FROM OLD.rider_commission_bps
         OR NEW.delivery_fee_minor IS DISTINCT FROM OLD.delivery_fee_minor THEN
        RAISE EXCEPTION 'job delivery split is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_jobs_delivery_snapshot_immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER order_jobs_delivery_snapshot_trigger BEFORE UPDATE ON order_jobs
      FOR EACH ROW EXECUTE FUNCTION protect_job_delivery_snapshot();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER order_jobs_delivery_snapshot_trigger ON order_jobs;
    DROP FUNCTION protect_job_delivery_snapshot();
    DROP TRIGGER orders_delivery_snapshot_trigger ON orders;
    DROP FUNCTION protect_order_delivery_snapshot();
    ALTER TABLE orders DROP COLUMN rider_payout_minor, DROP COLUMN platform_delivery_share_minor,
      DROP COLUMN rider_commission_bps;
    ALTER TABLE order_jobs DROP COLUMN rider_payout_minor, DROP COLUMN platform_delivery_share_minor,
      DROP COLUMN rider_commission_bps;
    UPDATE platform_settings SET settings = settings - 'riderCommissionBps';
  `);
}
