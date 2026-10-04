export function up(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    CREATE TABLE season_windows (
      id text PRIMARY KEY,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      start_date date NOT NULL CHECK (start_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
      end_date date NOT NULL CHECK (end_date BETWEEN start_date AND DATE '9999-12-31'),
      demand_level text NOT NULL CHECK (demand_level IN ('Normal', 'Busy', 'Peak')),
      message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 500),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      notice_queued_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX season_windows_dates_idx ON season_windows (start_date, end_date);
    CREATE FUNCTION preserve_season_notice_marker() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.notice_queued_at IS NOT NULL AND NEW.notice_queued_at IS DISTINCT FROM OLD.notice_queued_at THEN
        RAISE EXCEPTION 'season notice marker is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER season_notice_marker_immutable BEFORE UPDATE ON season_windows
      FOR EACH ROW EXECUTE FUNCTION preserve_season_notice_marker();
    UPDATE platform_settings SET settings = settings ||
      '{"seasonWindowPush":{"enabled":false,"version":1}}'::jsonb
      WHERE NOT settings ? 'seasonWindowPush';
  `);
}

export function down(pgm) {
  pgm.sql(`DROP TABLE season_windows; DROP FUNCTION preserve_season_notice_marker();
    UPDATE platform_settings SET settings = settings - 'seasonWindowPush';`);
}
