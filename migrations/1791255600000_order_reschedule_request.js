/** A single bounded request lives with the order; its original facts cannot be erased or replaced. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION protect_order_reschedule_request() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_request jsonb; new_request jsonb; field text;
    BEGIN
      old_request := OLD.data->'rescheduleRequest';
      new_request := NEW.data->'rescheduleRequest';
      IF old_request IS NOT NULL AND old_request <> 'null'::jsonb THEN
        IF new_request IS NULL OR new_request = 'null'::jsonb THEN
          RAISE EXCEPTION 'order reschedule request must be preserved' USING ERRCODE='23514';
        END IF;
        FOREACH field IN ARRAY ARRAY['id','supplierId','reason','requestedAt','expiresAt',
          'originalReadyBy','originalPromiseBy','proposedReadyBy','proposedPromiseBy'] LOOP
          IF old_request->field IS DISTINCT FROM new_request->field THEN
            RAISE EXCEPTION 'order reschedule request facts are immutable' USING ERRCODE='23514';
          END IF;
        END LOOP;
        IF old_request->>'status' <> 'pending' AND old_request->'status' IS DISTINCT FROM new_request->'status' THEN
          RAISE EXCEPTION 'order reschedule answer is final' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER order_reschedule_request_immutable BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION protect_order_reschedule_request();
  `);
}
export async function down(pgm) {
  pgm.sql('DROP TRIGGER order_reschedule_request_immutable ON orders; DROP FUNCTION protect_order_reschedule_request();');
}
