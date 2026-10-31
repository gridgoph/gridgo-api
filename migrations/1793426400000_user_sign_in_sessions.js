/** One-way fingerprints of observed sessions, never tokens or credentials. */
export const up = pgm => pgm.sql(`
  CREATE TABLE user_sign_in_sessions (
    user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
    authenticated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, session_hash)
  );
`);

export const down = pgm => pgm.sql('DROP TABLE user_sign_in_sessions');
