/** New team state is separate so overlapping older API writers preserve it. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE shop_team_settings (
      shop_id text PRIMARY KEY REFERENCES users(id),
      jobs_handled_by text CHECK (jobs_handled_by IN ('just_me','me_and_staff')),
      show_ranking_to_staff boolean,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE shop_team_member_settings (
      shop_id text NOT NULL, user_id text NOT NULL,
      manager boolean, job_alerts boolean, photo_file_id text REFERENCES files(file_id),
      PRIMARY KEY (shop_id,user_id),
      FOREIGN KEY (shop_id,user_id) REFERENCES shop_memberships(shop_id,user_id)
    );
    CREATE TABLE shop_pin_staff (
      id text PRIMARY KEY, shop_id text NOT NULL REFERENCES users(id),
      name text NOT NULL, role text NOT NULL CHECK (role IN ('staff','manager')),
      status text NOT NULL CHECK (status IN ('active','removed')),
      pin_hash text NOT NULL, pin_version integer NOT NULL,
      failed_attempts integer NOT NULL, blocked_until timestamptz,
      job_alerts boolean NOT NULL, photo_file_id text REFERENCES files(file_id),
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    );
    CREATE INDEX shop_pin_staff_shop_idx ON shop_pin_staff(shop_id);
    CREATE TABLE shop_worker_sessions (
      shop_id text NOT NULL REFERENCES users(id), user_id text NOT NULL REFERENCES users(id),
      session_hash text NOT NULL, pin_staff_id text REFERENCES shop_pin_staff(id),
      pin_version integer, token_hash text, expires_at timestamptz,
      failed_attempts integer NOT NULL, blocked_until timestamptz,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (shop_id,user_id,session_hash)
    );
    ALTER TABLE order_actions ADD COLUMN shop_id text,
      ADD COLUMN actor_pin_staff_id text, ADD COLUMN acceptance_milliseconds bigint;
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
