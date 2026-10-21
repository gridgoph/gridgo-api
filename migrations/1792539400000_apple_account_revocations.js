export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE account_deletion_apple_revocations (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES account_deletion_requests(id) ON DELETE CASCADE,
      client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
      code_digest text NOT NULL CHECK (code_digest ~ '^[a-f0-9]{64}$'),
      status text NOT NULL CHECK (status IN ('revoked', 'retry_required')),
      error_code text,
      http_status smallint NOT NULL CHECK (http_status IN (200,400,403,502)),
      attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      revoked_at timestamptz,
      CHECK ((status='revoked' AND revoked_at IS NOT NULL AND error_code IS NULL)
        OR (status='retry_required' AND revoked_at IS NULL AND error_code IS NOT NULL)),
      UNIQUE (request_id, client_id, code_digest)
    );
    CREATE INDEX account_deletion_apple_latest ON account_deletion_apple_revocations(request_id, client_id, attempted_at DESC);
  `);
}

export async function down(pgm) {
  pgm.sql('DROP TABLE account_deletion_apple_revocations');
}
