/** Private additive state: historical profile/account upserts never touch it. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE supplier_signups (
      clerk_user_id text PRIMARY KEY,
      supplier_id text UNIQUE REFERENCES users(id),
      version integer NOT NULL,
      steps jsonb NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE supplier_payout_policies (
      supplier_id text PRIMARY KEY REFERENCES users(id),
      holder text,
      consent jsonb,
      paused_until timestamptz,
      updated_at timestamptz NOT NULL
    );
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
