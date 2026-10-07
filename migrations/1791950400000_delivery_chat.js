/**
 * The client and the assigned rider can message each other during a door
 * delivery (gridgo-client#198). A conversation belongs to one order and one
 * rider, so a reassigned job starts clean. Messages are removed one day after
 * delivery by the lifecycle sweep; nothing here keeps them longer.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS delivery_chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_role text NOT NULL CHECK (sender_role IN ('client', 'rider')),
      body text NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 1000),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS delivery_chat_messages_conversation_idx
      ON delivery_chat_messages (order_id, rider_id, created_at, id);

    CREATE TABLE IF NOT EXISTS delivery_chat_reads (
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      last_read_at timestamptz NOT NULL,
      PRIMARY KEY (order_id, rider_id, user_id)
    );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS delivery_chat_reads;
    DROP TABLE IF EXISTS delivery_chat_messages;
  `);
}
