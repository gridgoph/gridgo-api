/**
 * A client (or shop, or rider) may keep more than one Operations conversation.
 * The first message still opens a thread; New chat opens another.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE support_chat_threads
      DROP CONSTRAINT IF EXISTS support_chat_threads_party_user_id_party_role_key;

    CREATE INDEX IF NOT EXISTS support_chat_threads_party_history_idx
      ON support_chat_threads (
        party_user_id,
        party_role,
        last_message_at DESC NULLS LAST,
        updated_at DESC
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS support_chat_threads_party_history_idx;

    ALTER TABLE support_chat_threads
      ADD CONSTRAINT support_chat_threads_party_user_id_party_role_key
      UNIQUE (party_user_id, party_role);
  `);
}
