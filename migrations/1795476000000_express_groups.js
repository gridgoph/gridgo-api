export const shorthands = undefined;
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE express_groups (
      id text PRIMARY KEY, host_id text NOT NULL REFERENCES users(id), state text NOT NULL,
      token_hash text NOT NULL UNIQUE, closes_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      total_minor bigint NOT NULL DEFAULT 0, delivery_fee_minor bigint NOT NULL DEFAULT 0, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX express_groups_host_state ON express_groups(host_id,state);
    CREATE INDEX express_groups_due ON express_groups(state,closes_at);
    CREATE TABLE express_group_members (
      group_id text NOT NULL REFERENCES express_groups(id), user_id text NOT NULL REFERENCES users(id),
      active boolean NOT NULL DEFAULT true, joined_at timestamptz NOT NULL,
      print_subtotal_minor bigint NOT NULL DEFAULT 0, delivery_share_minor bigint NOT NULL DEFAULT 0,
      amount_owed_minor bigint NOT NULL DEFAULT 0, data jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY(group_id,user_id)
    );
    CREATE INDEX express_group_members_user ON express_group_members(user_id) WHERE active;
  `);
}
export function down(pgm) { pgm.sql('DROP TABLE express_group_members, express_groups'); }
