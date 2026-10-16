/** Private audio-call control plane; never audio bytes. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE order_calls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      pair text NOT NULL CHECK (pair IN ('delivery','pickup')),
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      caller_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      callee_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      caller_role text NOT NULL,
      callee_role text NOT NULL,
      state text NOT NULL CHECK (state IN ('ringing','accepted','declined','cancelled','ended','missed')),
      created_at timestamptz NOT NULL,
      ring_expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      ended_at timestamptz,
      caller_seen_at timestamptz NOT NULL,
      callee_seen_at timestamptz NOT NULL,
      CHECK (caller_id <> callee_id),
      CHECK ((pair = 'delivery' AND ((caller_role = 'client' AND callee_role = 'rider') OR
                                    (caller_role = 'rider' AND callee_role = 'client'))) OR
             (pair = 'pickup' AND ((caller_role = 'supplier' AND callee_role = 'rider') OR
                                  (caller_role = 'rider' AND callee_role = 'supplier'))))
    );
    CREATE UNIQUE INDEX order_calls_one_active_pair ON order_calls (order_id, pair)
      WHERE state IN ('ringing','accepted');
    CREATE INDEX order_calls_order ON order_calls (order_id, created_at DESC);
    CREATE TABLE order_call_signals (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id uuid NOT NULL REFERENCES order_calls(id) ON DELETE CASCADE,
      sender_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 64),
      kind text NOT NULL CHECK (kind IN ('offer','answer','ice')),
      payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 65536),
      created_at timestamptz NOT NULL,
      UNIQUE (call_id, sender_id, client_id)
    );
    CREATE INDEX order_call_signals_call ON order_call_signals (call_id, id);
    CREATE UNIQUE INDEX order_call_one_description ON order_call_signals (call_id, kind)
      WHERE kind IN ('offer','answer');
  `);
}
export async function down(pgm) {
  pgm.sql('DROP TABLE order_call_signals; DROP TABLE order_calls;');
}
