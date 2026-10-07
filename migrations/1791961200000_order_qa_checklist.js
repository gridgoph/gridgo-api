/** Per-item Operations results stay beside their review snapshot in orders.data. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders ADD CONSTRAINT orders_qa_checklist_check CHECK (
      data #> '{fileCheck,checklist}' IS NULL
      OR data #> '{fileCheck,checklist}' = 'null'::jsonb
      OR (
        data #> '{fileCheck,checklist,version}' = '1'::jsonb
        AND jsonb_typeof(data #> '{fileCheck,checklist,checks}') = 'object'
        AND (data #> '{fileCheck,checklist,checks}') - ARRAY['artwork','spec','quantity','address'] = '{}'::jsonb
        AND jsonb_typeof(data #> '{fileCheck,checklist,checks,artwork}') = 'boolean'
        AND jsonb_typeof(data #> '{fileCheck,checklist,checks,spec}') = 'boolean'
        AND jsonb_typeof(data #> '{fileCheck,checklist,checks,quantity}') = 'boolean'
        AND jsonb_typeof(data #> '{fileCheck,checklist,checks,address}') = 'boolean'
        AND (data #>> '{fileCheck,status}' <> 'passed'
          OR data #> '{fileCheck,checklist,checks}' = '{"artwork":true,"spec":true,"quantity":true,"address":true}'::jsonb)
      ) IS TRUE
    );
  `);
}

export async function down(pgm) {
  pgm.sql('ALTER TABLE orders DROP CONSTRAINT orders_qa_checklist_check;');
}
