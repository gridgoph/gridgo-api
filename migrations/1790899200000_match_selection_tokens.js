/** Opaque, client/request-bound match selections and durable line deadlines. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE client_match_selections (
      token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      client_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id text NOT NULL,
      expires_at timestamptz NOT NULL,
      selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'object')
    );
    CREATE INDEX client_match_selections_expiry_idx ON client_match_selections(expires_at);
    ALTER TABLE client_cart_lines ADD COLUMN match_deadline timestamptz;
  `);
}

export async function down(pgm) {
  pgm.sql(`ALTER TABLE client_cart_lines DROP COLUMN match_deadline;
    DROP TABLE client_match_selections;`);
}
