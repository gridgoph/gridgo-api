/** Stable insertion order for concurrent replies that share the same millisecond. */
export async function up(pgm) {
  pgm.sql(`ALTER TABLE client_shop_chat_messages ADD COLUMN position bigint;
    WITH history AS (SELECT id,row_number() OVER(ORDER BY created_at,id) AS ordinal FROM client_shop_chat_messages)
      UPDATE client_shop_chat_messages m SET position=history.ordinal FROM history WHERE m.id=history.id;
    ALTER TABLE client_shop_chat_messages ALTER COLUMN position SET NOT NULL;
    ALTER TABLE client_shop_chat_messages ALTER COLUMN position ADD GENERATED ALWAYS AS IDENTITY;
    SELECT setval(pg_get_serial_sequence('client_shop_chat_messages','position'),
      COALESCE((SELECT max(position) FROM client_shop_chat_messages),0)+1,false);
    CREATE UNIQUE INDEX client_shop_chat_position_idx ON client_shop_chat_messages(position);
    CREATE INDEX client_shop_chat_supplier_position_idx ON client_shop_chat_messages(order_id,supplier_id,position);
    ALTER TABLE client_shop_chat_reads ADD COLUMN last_read_position bigint NOT NULL DEFAULT 0;
    UPDATE client_shop_chat_reads r SET last_read_position=COALESCE((SELECT max(m.position) FROM client_shop_chat_messages m
      WHERE m.order_id=r.order_id AND m.created_at<=r.last_read_at),0);`);
}
export async function down() { throw new Error('Forward-only migration'); }
