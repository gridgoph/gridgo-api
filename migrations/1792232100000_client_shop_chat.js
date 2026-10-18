/** Masked production conversations retained with the order as dispute evidence. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE client_shop_chat_threads (
      order_id text PRIMARY KEY REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      flagged_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX client_shop_chat_threads_activity_idx ON client_shop_chat_threads (updated_at DESC, order_id);
    CREATE TABLE client_shop_chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL REFERENCES client_shop_chat_threads(order_id) ON UPDATE CASCADE ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
      sender_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
      sender_role text NOT NULL CHECK (sender_role IN ('client','supplier','gridgo')),
      original_body text NOT NULL CHECK (char_length(original_body) <= 1000),
      masked_body text NOT NULL CHECK (char_length(masked_body) <= 16000),
      contact_attempt boolean NOT NULL DEFAULT false,
      attachment_file_ids text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (order_id, id),
      CHECK (btrim(original_body) <> '' OR cardinality(attachment_file_ids) > 0),
      CHECK (cardinality(attachment_file_ids) <= 4)
    );
    CREATE INDEX client_shop_chat_messages_history_idx ON client_shop_chat_messages (order_id, created_at, id);
    CREATE INDEX client_shop_chat_messages_attempt_idx ON client_shop_chat_messages (order_id, sender_user_id) WHERE contact_attempt;
    CREATE TABLE client_shop_chat_reads (
      order_id text NOT NULL REFERENCES client_shop_chat_threads(order_id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      last_read_at timestamptz NOT NULL,
      PRIMARY KEY (order_id, user_id)
    );
    CREATE TABLE client_shop_chat_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL,
      message_id uuid NOT NULL,
      reporter_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
      reporter_role text NOT NULL CHECK (reporter_role IN ('client','supplier','gridgo')),
      reason text NOT NULL CHECK (reason IN ('contact_sharing','inappropriate','change_request','other')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (message_id, reporter_user_id),
      FOREIGN KEY (order_id, message_id) REFERENCES client_shop_chat_messages(order_id, id) ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE INDEX client_shop_chat_reports_thread_idx ON client_shop_chat_reports (order_id, created_at, id);
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message','pickup_chat_message','client_shop_chat_message'
    ));
  `);
}
// Evidence migrations are forward-only: no down migration deletes conversations.
