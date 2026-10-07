/**
 * A support message may carry photos. The body can stay empty when a
 * picture is the message. Chat files bind through file_references, not
 * POST /files/:id/attach.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE support_chat_messages
      DROP CONSTRAINT IF EXISTS support_chat_messages_check;
    ALTER TABLE support_chat_messages
      DROP CONSTRAINT IF EXISTS support_chat_messages_body_check;

    ALTER TABLE support_chat_messages
      ADD COLUMN IF NOT EXISTS attachment_file_ids text[] NOT NULL DEFAULT '{}';

    ALTER TABLE support_chat_messages
      ADD CONSTRAINT support_chat_messages_body_check
      CHECK (
        char_length(body) <= 4000
        AND (
          btrim(body) <> ''
          OR cardinality(attachment_file_ids) > 0
        )
      );

    ALTER TABLE support_chat_messages
      ADD CONSTRAINT support_chat_messages_attachments_check
      CHECK (cardinality(attachment_file_ids) <= 4);

    CREATE INDEX IF NOT EXISTS support_chat_messages_images_idx
      ON support_chat_messages (thread_id, created_at, id)
      WHERE cardinality(attachment_file_ids) > 0;

    ALTER TABLE file_references
      DROP CONSTRAINT IF EXISTS file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
        'order','supplier_service','user','rider_document','supplier_catalog_item',
        'supplier_shop_media','supplier_payout_account','tracker_decision',
        'refund_request','support_chat_message'
      ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE file_references
      DROP CONSTRAINT IF EXISTS file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
        'order','supplier_service','user','rider_document','supplier_catalog_item',
        'supplier_shop_media','supplier_payout_account','tracker_decision',
        'refund_request'
      ));

    DROP INDEX IF EXISTS support_chat_messages_images_idx;

    ALTER TABLE support_chat_messages
      DROP CONSTRAINT IF EXISTS support_chat_messages_attachments_check;
    ALTER TABLE support_chat_messages
      DROP CONSTRAINT IF EXISTS support_chat_messages_body_check;
    ALTER TABLE support_chat_messages
      DROP COLUMN IF EXISTS attachment_file_ids;
    ALTER TABLE support_chat_messages
      ADD CONSTRAINT support_chat_messages_check
      CHECK (btrim(body) <> '' AND char_length(body) <= 4000);
  `);
}
