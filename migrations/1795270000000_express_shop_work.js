/** Supplier Express availability and job-scoped file-access observations. */
export async function up(pgm) {
 pgm.sql(`
  ALTER TABLE supplier_profiles ADD COLUMN express_enabled boolean NOT NULL DEFAULT true;
  CREATE TABLE shop_file_accesses (
    job_id text NOT NULL REFERENCES order_jobs(id) ON DELETE CASCADE,
    order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shop_id text NOT NULL REFERENCES users(id),
    user_id text NOT NULL REFERENCES users(id),
    device_id text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    file_id text NOT NULL REFERENCES files(file_id),
    action text NOT NULL CHECK (action IN ('opened','downloaded','download_authorized')),
    first_at timestamptz NOT NULL,
    last_at timestamptz NOT NULL CHECK (last_at >= first_at),
    access_count integer NOT NULL CHECK (access_count > 0),
    PRIMARY KEY (job_id,shop_id,user_id,device_id,file_id,action)
  );
  CREATE INDEX shop_file_accesses_order_idx ON shop_file_accesses(order_id);
 `);
}
export async function down() { throw new Error('Forward-only migration'); }
