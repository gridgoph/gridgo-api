/** Daily campaign enqueues commit with their announcement/inbox/outbox. */
export const up = pgm => pgm.sql(`
  ALTER TABLE tester_program_settings
    ADD COLUMN daily_reminder_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN daily_reminder_hour integer NOT NULL DEFAULT 10 CHECK (daily_reminder_hour BETWEEN 0 AND 23);
  CREATE TABLE tester_program_play_reminder_runs (
    app text NOT NULL REFERENCES tester_program_settings(app) ON DELETE CASCADE,
    manila_date date NOT NULL,
    queued_at timestamptz NOT NULL,
    PRIMARY KEY (app,manila_date)
  );
  CREATE TABLE tester_program_play_reminder_recipients (
    app text NOT NULL REFERENCES tester_program_settings(app) ON DELETE CASCADE,
    manila_date date NOT NULL,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    queued_at timestamptz NOT NULL,
    PRIMARY KEY (app,manila_date,user_id)
  );
  -- A manual broadcast made before deployment already owns that day's slot.
  INSERT INTO tester_program_play_reminder_recipients(app,manila_date,user_id,queued_at)
    SELECT data->>'appRole', (created_at AT TIME ZONE 'Asia/Manila')::date, user_id, min(created_at)
    FROM notifications WHERE type='play_optin' AND data->>'appRole' IN ('client','supplier','rider')
    GROUP BY data->>'appRole', (created_at AT TIME ZONE 'Asia/Manila')::date, user_id
    ON CONFLICT DO NOTHING;
`);
export const down = () => { throw new Error('Campaign reminder history requires a forward migration'); };
