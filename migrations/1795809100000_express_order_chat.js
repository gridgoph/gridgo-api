/** Additive order conversation metadata. Existing regular conversations retain their contract. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_shop_chat_threads ADD COLUMN owner_worker_key text, ADD COLUMN owner_first_name text;
    ALTER TABLE client_shop_chat_messages ADD COLUMN sender_first_name text,
      ADD COLUMN sender_shop text, ADD COLUMN sender_worker_key text, ADD COLUMN sender_photo_file_id text,
      ADD COLUMN system_event text CHECK (system_event IN ('accepted','ready')),
      ADD COLUMN hidden_attachment_count integer NOT NULL DEFAULT 0 CHECK (hidden_attachment_count BETWEEN 0 AND 4);
    CREATE UNIQUE INDEX client_shop_chat_system_once ON client_shop_chat_messages(order_id,supplier_id,system_event) WHERE system_event IS NOT NULL;
    CREATE INDEX client_shop_chat_shop_history ON client_shop_chat_messages(supplier_id,order_id,created_at DESC,id DESC);
    CREATE TABLE client_shop_chat_typing (
      order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES users(id), worker_key text NOT NULL,
      user_id text NOT NULL REFERENCES users(id), first_name text NOT NULL,
      sender_role text NOT NULL CHECK (sender_role IN ('client','supplier')),
      expires_at timestamptz NOT NULL, PRIMARY KEY(order_id,supplier_id,worker_key)
    );
    CREATE INDEX client_shop_chat_typing_expiry ON client_shop_chat_typing(expires_at);
    ALTER TABLE platform_settings ADD CONSTRAINT order_chat_pickup_hours CHECK (
      NOT settings ? 'orderChatCloseAfterPickupHours' OR
      (jsonb_typeof(settings->'orderChatCloseAfterPickupHours')='number'
        AND (settings->>'orderChatCloseAfterPickupHours')::numeric=trunc((settings->>'orderChatCloseAfterPickupHours')::numeric)
        AND (settings->>'orderChatCloseAfterPickupHours')::numeric BETWEEN 1 AND 168)
    );
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
