/** Extend the existing Android waitlist to manual TestFlight enrollment. */
export const up = pgm => pgm.sql(`
  -- Existing rows are already NOT NULL and CHECK'd to android, so their
  -- platform is preserved without rewriting consent or grant history.
  ALTER TABLE early_access_signups
    ALTER COLUMN platform SET DEFAULT 'android',
    DROP CONSTRAINT early_access_signups_platform_check,
    DROP CONSTRAINT early_access_signups_check,
    ADD CONSTRAINT early_access_signups_platform_check CHECK (platform IN ('android','iphone')),
    ADD CONSTRAINT early_access_signups_check CHECK (
      (status = 'pending' AND granted_at IS NULL AND granted_by IS NULL AND opt_in_url IS NULL)
      OR (status = 'granted' AND granted_at IS NOT NULL AND granted_by IS NOT NULL
        AND ((platform = 'android' AND opt_in_url IS NOT NULL)
          OR (platform = 'iphone' AND opt_in_url IS NULL)))
    );
`);
export const down = () => { throw new Error('Early access phone type and grant history require a forward migration'); };
