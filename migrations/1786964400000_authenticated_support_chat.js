/**
 * Authenticated Operations chat: one thread per client, supplier, or rider.
 * Separate from public landing-page support tickets (support_desk).
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE support_chat_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      party_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      party_role text NOT NULL CHECK (party_role IN ('client', 'supplier', 'rider')),
      last_message_at timestamptz,
      last_message_preview text,
      last_message_sender_role text CHECK (
        last_message_sender_role IS NULL
        OR last_message_sender_role IN ('client', 'supplier', 'rider', 'ops_admin', 'super_admin')
      ),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (party_user_id, party_role)
    );

    CREATE INDEX support_chat_threads_inbox_idx
      ON support_chat_threads (last_message_at DESC NULLS LAST, updated_at DESC);

    CREATE TABLE support_chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES support_chat_threads(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_role text NOT NULL CHECK (sender_role IN ('client', 'supplier', 'rider', 'ops_admin', 'super_admin')),
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (btrim(body) <> '' AND char_length(body) <= 4000)
    );

    CREATE INDEX support_chat_messages_thread_created_idx
      ON support_chat_messages (thread_id, created_at, id);

    CREATE TABLE support_chat_reads (
      thread_id uuid NOT NULL REFERENCES support_chat_threads(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      last_read_at timestamptz NOT NULL DEFAULT now(),
      last_read_message_id uuid REFERENCES support_chat_messages(id) ON UPDATE CASCADE ON DELETE SET NULL,
      PRIMARY KEY (thread_id, user_id)
    );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS support_chat_reads;
    DROP TABLE IF EXISTS support_chat_messages;
    DROP TABLE IF EXISTS support_chat_threads;
  `);
}
