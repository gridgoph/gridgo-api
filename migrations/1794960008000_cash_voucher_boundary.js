export async function up(pgm) {
  pgm.sql(`DO $patch$ DECLARE definition text; updated text;
    BEGIN
      SELECT pg_get_functiondef('guard_voucher_order()'::regprocedure) INTO definition;
      updated:=replace(definition,'NEW.online_due_minor<>NEW.total_minor',
        'NEW.online_due_minor<>(CASE WHEN NEW.payment_plan=''cash_delivery'' THEN 0 ELSE NEW.total_minor END)');
      IF updated=definition THEN RAISE EXCEPTION 'cash voucher boundary patch failed'; END IF;
      EXECUTE updated;
    END $patch$;`);
}
export async function down() { throw new Error('Cash voucher boundaries require a forward migration'); }
