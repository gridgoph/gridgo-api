/** Shop/assigned-rider conversations and private photos (C2BE8E7A). */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE pickup_chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sender_role text NOT NULL CHECK (sender_role IN ('supplier', 'rider')),
      body text NOT NULL,
      attachment_file_ids text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pickup_chat_messages_body_check CHECK (
        char_length(body) <= 1000 AND (btrim(body) <> '' OR cardinality(attachment_file_ids) > 0)
      ),
      CONSTRAINT pickup_chat_messages_attachments_check CHECK (cardinality(attachment_file_ids) <= 4)
    );
    CREATE INDEX pickup_chat_messages_conversation_idx
      ON pickup_chat_messages (order_id, rider_id, created_at, id);
    CREATE TABLE pickup_chat_reads (
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      last_read_at timestamptz NOT NULL,
      PRIMARY KEY (order_id, rider_id, user_id)
    );
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message','pickup_chat_message'
    ));
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DELETE FROM file_references WHERE reference_type = 'pickup_chat_message';
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item',
      'supplier_shop_media','supplier_payout_account','tracker_decision',
      'refund_request','support_chat_message','delivery_chat_message'
    ));
    DROP TABLE pickup_chat_reads;
    DROP TABLE pickup_chat_messages;
  `);
}
