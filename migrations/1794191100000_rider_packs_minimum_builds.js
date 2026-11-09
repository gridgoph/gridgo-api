/** Version the published custody minimum alongside the existing settings handshake. */
export const up = pgm => pgm.sql(`
  UPDATE platform_settings
     SET settings = settings || '{"riderPacksMinimumBuilds":{"client":0,"supplier":0,"rider":161}}'::jsonb,
         version = version + 1
   WHERE NOT settings ? 'riderPacksMinimumBuilds';
`);
export const down = () => { throw new Error('Use a forward migration for app minimum builds'); };
