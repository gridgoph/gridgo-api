/**
 * A delivery message may carry photos (gridgo-client#218). The body can stay
 * empty when a picture is the message. Photos bind through file_references,
 * not POST /files/:id/attach, and go with the conversation one day after
 * delivery.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE delivery_chat_messages
      DROP CONSTRAINT IF EXISTS delivery_chat_messages_body_check;

    ALTER TABLE delivery_chat_messages
      ADD COLUMN IF NOT EXISTS attachment_file_ids text[] NOT NULL DEFAULT '{}';

    ALTER TABLE delivery_chat_messages
      ADD CONSTRAINT delivery_chat_messages_body_check
      CHECK (
        char_length(body) <= 1000
        AND (btrim(body) <> '' OR cardinality(attachment_file_ids) > 0)
      );

    ALTER TABLE delivery_chat_messages
      ADD CONSTRAINT delivery_chat_messages_attachments_check
      CHECK (cardinality(attachment_file_ids) <= 4);

    ALTER TABLE file_references
      DROP CONSTRAINT IF EXISTS file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
        'order','supplier_service','user','rider_document','supplier_catalog_item',
        'supplier_shop_media','supplier_payout_account','tracker_decision',
        'refund_request','support_chat_message','delivery_chat_message'
      ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM file_references WHERE reference_type = 'delivery_chat_message';
    ALTER TABLE file_references
      DROP CONSTRAINT IF EXISTS file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
        'order','supplier_service','user','rider_document','supplier_catalog_item',
        'supplier_shop_media','supplier_payout_account','tracker_decision',
        'refund_request','support_chat_message'
      ));

    DELETE FROM delivery_chat_messages WHERE btrim(body) = '';
    ALTER TABLE delivery_chat_messages
      DROP CONSTRAINT IF EXISTS delivery_chat_messages_attachments_check;
    ALTER TABLE delivery_chat_messages
      DROP CONSTRAINT IF EXISTS delivery_chat_messages_body_check;
    ALTER TABLE delivery_chat_messages
      DROP COLUMN IF EXISTS attachment_file_ids;
    ALTER TABLE delivery_chat_messages
      ADD CONSTRAINT delivery_chat_messages_body_check
      CHECK (btrim(body) <> '' AND char_length(body) <= 1000);
  `);
}
