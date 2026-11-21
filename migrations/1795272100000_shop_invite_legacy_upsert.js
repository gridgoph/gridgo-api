/** Let a previous API version consume invites issued with a 24-hour deadline. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION shop_invite_insert_lifetime() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- CHECK runs before ON CONFLICT. Legacy writers omit lifetime_hours and
      -- receive DEFAULT 48 even when upserting an existing 24-hour invite.
      -- Derive only the snapshot; never change the issued timestamps.
      IF NEW.expires_at = NEW.created_at + interval '24 hours' THEN
        NEW.lifetime_hours := 24;
      ELSIF NEW.expires_at = NEW.created_at + interval '48 hours' THEN
        NEW.lifetime_hours := 48;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER shop_invite_insert_lifetime BEFORE INSERT ON shop_invites
      FOR EACH ROW EXECUTE FUNCTION shop_invite_insert_lifetime();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
