/** Preserve Operations originals independently of the supplier production file. */
export async function up(pgm) {
 pgm.sql(`ALTER TABLE order_line_items ADD COLUMN express_original_file_id text REFERENCES files(file_id) DEFERRABLE INITIALLY DEFERRED,
   ADD COLUMN express_original_guidance jsonb;
 CREATE FUNCTION guard_express_original() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF OLD.snapshot_finalized AND ROW(OLD.express_original_file_id,OLD.express_original_guidance)
      IS DISTINCT FROM ROW(NEW.express_original_file_id,NEW.express_original_guidance) THEN
     RAISE EXCEPTION 'Express original evidence is immutable' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END $$;
 CREATE TRIGGER express_original_immutable BEFORE UPDATE ON order_line_items FOR EACH ROW EXECUTE FUNCTION guard_express_original();
 CREATE FUNCTION guard_express_rendering() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF OLD.data ? 'expressRendering' AND (OLD.data->'expressRendering' IS DISTINCT FROM NEW.data->'expressRendering'
     OR OLD.state='ready' AND NEW.state='ready' AND ROW(OLD.object_key,OLD.size_bytes,OLD.owner_id) IS DISTINCT FROM ROW(NEW.object_key,NEW.size_bytes,NEW.owner_id)) THEN
     RAISE EXCEPTION 'Express rendering identity is immutable' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END $$;
 CREATE TRIGGER express_rendering_immutable BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION guard_express_rendering();
 CREATE FUNCTION check_express_page_price() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE total numeric; pages jsonb := NEW.express_print#>'{pagePricing,pages}';
 BEGIN
   IF NEW.express_print->>'printVersion'='2' AND NEW.express_print ? 'pagePricing' THEN
     IF jsonb_typeof(pages) IS DISTINCT FROM 'array' OR jsonb_array_length(pages) <> (NEW.document_pages->>'printed')::int THEN
       RAISE EXCEPTION 'Express page price count mismatch' USING ERRCODE='23514'; END IF;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(pages) p WHERE jsonb_typeof(p->'priceMinor') IS DISTINCT FROM 'number'
       OR (p->>'priceMinor')::numeric NOT BETWEEN 0 AND 9007199254740991 OR trunc((p->>'priceMinor')::numeric) <> (p->>'priceMinor')::numeric) THEN
       RAISE EXCEPTION 'Express page price invalid' USING ERRCODE='23514'; END IF;
     SELECT sum((p->>'priceMinor')::numeric)*NEW.quantity INTO total FROM jsonb_array_elements(pages) p;
     IF total IS DISTINCT FROM NEW.line_subtotal_minor::numeric OR total IS DISTINCT FROM (NEW.express_print#>>'{pagePricing,subtotalMinor}')::numeric THEN
       RAISE EXCEPTION 'Express page price total mismatch' USING ERRCODE='23514'; END IF;
   END IF;
   RETURN NEW;
 END $$;
 CREATE TRIGGER express_page_price_math BEFORE INSERT OR UPDATE ON order_line_items FOR EACH ROW EXECUTE FUNCTION check_express_page_price();`);
}
export async function down(){throw new Error('Retain original Express evidence; use a forward migration.');}
