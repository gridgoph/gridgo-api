/** Additive tester campaign configuration; never enrolls or broadcasts. */
export const up = pgm => pgm.sql(`
  ALTER TABLE tester_program_settings
    ADD COLUMN campaign_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN opt_in_url text,
    ADD COLUMN group_join_url text,
    ADD COLUMN target integer NOT NULL DEFAULT 12 CHECK (target BETWEEN 1 AND 10000);
  INSERT INTO tester_program_settings(app) VALUES ('client'),('supplier'),('rider') ON CONFLICT DO NOTHING;
  UPDATE tester_program_settings SET opt_in_url='https://play.google.com/apps/testing/ph.gridgo.' || app WHERE opt_in_url IS NULL;
  CREATE TABLE tester_program_play_optins (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app text NOT NULL REFERENCES tester_program_settings(app),
    email text,
    dismiss_count integer NOT NULL DEFAULT 0 CHECK (dismiss_count BETWEEN 0 AND 3),
    last_channel text CHECK (last_channel IN ('play','sideload')),
    last_platform text CHECK (last_platform IN ('android','ios','web')),
    shown_at timestamptz,
    tapped_at timestamptz,
    gmail_confirmed_at timestamptz,
    group_joined_at timestamptz,
    group_opened_at timestamptz,
    optin_opened_at timestamptz,
    opted_in_at timestamptz,
    opted_in_source text CHECK (opted_in_source IN ('play_channel','operations')),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id,app)
  );
  CREATE INDEX tester_program_play_unfinished ON tester_program_play_optins(app,updated_at DESC) WHERE opted_in_at IS NULL;
`);
export const down = () => { throw new Error('Tester campaign history requires a forward migration'); };
