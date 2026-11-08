/** Opt-in tester telemetry only; no existing account is enrolled by migration or seed. */
export const up = pgm => pgm.sql(`
  CREATE TABLE tester_program_settings (
    app text PRIMARY KEY CHECK (app IN ('client','supplier','rider')),
    play_clock_start_date date,
    opted_in_count integer NOT NULL DEFAULT 0 CHECK (opted_in_count >= 0),
    production_approved_at timestamptz
  );
  CREATE TABLE tester_program_enrollments (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app text NOT NULL CHECK (app IN ('client','supplier','rider')),
    added_at timestamptz NOT NULL,
    added_by text NOT NULL,
    removed_at timestamptz,
    completed_at timestamptz,
    CHECK (removed_at IS NULL OR removed_at >= added_at)
  );
  CREATE UNIQUE INDEX tester_program_active_enrollment ON tester_program_enrollments(user_id, app) WHERE removed_at IS NULL;
  CREATE INDEX tester_program_app_enrollments ON tester_program_enrollments(app, added_at) WHERE removed_at IS NULL;
  CREATE TABLE tester_program_checkins (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app text NOT NULL CHECK (app IN ('client','supplier','rider')),
    manila_date date NOT NULL,
    version text NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
    source text NOT NULL CHECK (source IN ('open','button')),
    checked_in_at timestamptz NOT NULL,
    latest_seen_at timestamptz NOT NULL,
    UNIQUE (user_id, app, manila_date)
  );
  -- A re-enrolment can explicitly check in on the same day without duplicating
  -- the account's daily record or counting any earlier days in its new run.
  CREATE TABLE tester_program_enrollment_days (
    enrollment_id text NOT NULL REFERENCES tester_program_enrollments(id) ON DELETE CASCADE,
    checkin_id text NOT NULL REFERENCES tester_program_checkins(id) ON DELETE CASCADE,
    PRIMARY KEY (enrollment_id, checkin_id)
  );
  CREATE TABLE tester_program_feedback (
    id text PRIMARY KEY,
    enrollment_id text NOT NULL REFERENCES tester_program_enrollments(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app text NOT NULL CHECK (app IN ('client','supplier','rider')),
    trigger text NOT NULL CHECK (trigger IN ('streak_3','streak_7','streak_10','streak_14','completed_order')),
    order_id text,
    shown_at timestamptz NOT NULL,
    tapped_at timestamptz,
    dismissed_at timestamptz
  );
  CREATE INDEX tester_program_feedback_user_app ON tester_program_feedback(user_id, app, shown_at DESC);
`);
export const down = () => { throw new Error('Tester history requires a forward migration'); };
