/** Change future delivery quotes only; never recalculate orders or jobs. */
export async function up(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM platform_settings WHERE settings ? 'deliveryFeeBands'
        AND (jsonb_typeof(settings->'deliveryFeeBands') IS DISTINCT FROM 'array'
          OR jsonb_array_length(settings->'deliveryFeeBands') <> 3)) THEN
        RAISE EXCEPTION 'Expected three legacy delivery fee bands; review the stored settings before migrating';
      END IF;
    END $$;
    UPDATE platform_settings
       SET settings = jsonb_set(settings, '{deliveryFeeBands}', jsonb_build_array(
         jsonb_build_object('zone', 'nearby', 'label', 'Nearby', 'maxDistanceMeters', 5000,
           'feeMinor', COALESCE(settings #> '{deliveryFeeBands,0,feeMinor}', '2500'::jsonb)),
         jsonb_build_object('zone', 'away', 'label', 'Away', 'maxDistanceMeters', 10000,
           'feeMinor', COALESCE(settings #> '{deliveryFeeBands,1,feeMinor}', '5000'::jsonb)),
         jsonb_build_object('zone', 'long_distance', 'label', 'Long Distance', 'maxDistanceMeters', 15000,
           'feeMinor', COALESCE(settings #> '{deliveryFeeBands,2,feeMinor}', '7500'::jsonb)),
         jsonb_build_object('zone', 'out_of_zone', 'label', 'Out of Zone', 'maxDistanceMeters', NULL,
           'baseFeeMinor', 7500, 'perKmMinor', 1000)
       )), version = version + 1;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    UPDATE platform_settings
       SET settings = jsonb_set(settings, '{deliveryFeeBands}', jsonb_build_array(
         jsonb_build_object('maxDistanceMeters', 4999, 'feeMinor', settings #> '{deliveryFeeBands,0,feeMinor}'),
         jsonb_build_object('maxDistanceMeters', 10000, 'feeMinor', settings #> '{deliveryFeeBands,1,feeMinor}'),
         jsonb_build_object('maxDistanceMeters', NULL, 'feeMinor', settings #> '{deliveryFeeBands,2,feeMinor}')
       )), version = version + 1;
  `);
}
