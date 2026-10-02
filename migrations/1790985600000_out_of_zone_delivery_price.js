/** Replace only the shipped placeholder; preserve flat fees and accepted quotes. */
function replacePrice(pgm, fromBase, fromPerKm, toBase, toPerKm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    UPDATE platform_settings
       SET settings = jsonb_set(settings, '{deliveryFeeBands}', (
         SELECT jsonb_agg(CASE
           WHEN band @> '{"zone":"out_of_zone","baseFeeMinor":${fromBase},"perKmMinor":${fromPerKm}}'::jsonb
           THEN band || '{"baseFeeMinor":${toBase},"perKmMinor":${toPerKm}}'::jsonb
           ELSE band END ORDER BY position)
         FROM jsonb_array_elements(settings->'deliveryFeeBands') WITH ORDINALITY AS bands(band, position)
       )), version = version + 1
     WHERE settings->'deliveryFeeBands' @>
       '[{"zone":"out_of_zone","baseFeeMinor":${fromBase},"perKmMinor":${fromPerKm}}]'::jsonb;
  `);
}

export async function up(pgm) {
  replacePrice(pgm, 7500, 1000, 4000, 1500);
}

export async function down(pgm) {
  replacePrice(pgm, 4000, 1500, 7500, 1000);
}
