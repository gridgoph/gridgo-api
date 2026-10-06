/** Product dates are independent; a mixed-date basket has no shared deadline. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_cart_lines ADD COLUMN deadline timestamptz;
    ALTER TABLE order_jobs ADD COLUMN deadline timestamptz;
    ALTER TABLE order_baskets ALTER COLUMN deadline DROP NOT NULL;
    CREATE FUNCTION protect_group_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.data->>'basketId' IS NOT NULL AND OLD.data ? 'deadline'
        AND (OLD.data->'deadline' IS DISTINCT FROM NEW.data->'deadline'
          OR OLD.data->'basketDeadline' IS DISTINCT FROM NEW.data->'basketDeadline') THEN
        RAISE EXCEPTION 'basket group deadline is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_group_deadline_immutable BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION protect_group_deadline();
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM order_baskets WHERE deadline IS NULL)
        OR EXISTS (SELECT 1 FROM client_cart_lines WHERE deadline IS NOT NULL)
        OR EXISTS (SELECT 1 FROM order_jobs WHERE deadline IS NOT NULL) THEN
        RAISE EXCEPTION 'Cannot reverse while product deadlines exist';
      END IF;
    END $$;
    DROP TRIGGER order_group_deadline_immutable ON orders;
    DROP FUNCTION protect_group_deadline();
    ALTER TABLE order_baskets ALTER COLUMN deadline SET NOT NULL;
    ALTER TABLE order_jobs DROP COLUMN deadline;
    ALTER TABLE client_cart_lines DROP COLUMN deadline;
  `);
}
