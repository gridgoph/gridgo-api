/**
 * Operations can look someone up and start a chat — including another
 * desk account. Party threads stay the public Operations inbox; a staff
 * pair is private to those two people.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE support_chat_threads
      DROP CONSTRAINT IF EXISTS support_chat_threads_party_role_check;

    ALTER TABLE support_chat_threads
      ADD COLUMN IF NOT EXISTS staff_peer_user_id text
        REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE;

    ALTER TABLE support_chat_threads
      ADD CONSTRAINT support_chat_threads_party_role_check
      CHECK (party_role IN ('client', 'supplier', 'rider', 'ops_admin', 'super_admin'));

    ALTER TABLE support_chat_threads
      ADD CONSTRAINT support_chat_threads_staff_peer_check
      CHECK (
        (
          staff_peer_user_id IS NULL
          AND party_role IN ('client', 'supplier', 'rider')
        )
        OR (
          staff_peer_user_id IS NOT NULL
          AND party_role IN ('ops_admin', 'super_admin')
          AND staff_peer_user_id <> party_user_id
        )
      );

    CREATE UNIQUE INDEX IF NOT EXISTS support_chat_threads_staff_pair_uidx
      ON support_chat_threads (
        LEAST(party_user_id, staff_peer_user_id),
        GREATEST(party_user_id, staff_peer_user_id)
      )
      WHERE staff_peer_user_id IS NOT NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS support_chat_threads_staff_pair_uidx;

    ALTER TABLE support_chat_threads
      DROP CONSTRAINT IF EXISTS support_chat_threads_staff_peer_check;

    ALTER TABLE support_chat_threads
      DROP CONSTRAINT IF EXISTS support_chat_threads_party_role_check;

    ALTER TABLE support_chat_threads
      DROP COLUMN IF EXISTS staff_peer_user_id;

    ALTER TABLE support_chat_threads
      ADD CONSTRAINT support_chat_threads_party_role_check
      CHECK (party_role IN ('client', 'supplier', 'rider'));
  `);
}
