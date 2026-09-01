/**
 * What matching needs before it can answer "the most capable and free shop,
 * for the date you gave".
 *
 * Three things, none of which the platform could express:
 *
 *   cost      a fourth ranking factor, so the saved ranking is four long
 *   schedule  when a shop is actually open, which lived only on its own phone
 *   reviews   what clients said, so quality stops meaning "filled in the form"
 *
 * Rankings saved before cost existed are three long and would fail the widened
 * check on their next write, so they are migrated in place rather than left to
 * break the first time a client opens the preferences screen. Cost goes last:
 * it is the factor they never got to place, and guessing it mattered most to
 * them would be putting words in their mouth.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_match_preferences
      DROP CONSTRAINT client_match_preferences_ranking_check;

    UPDATE client_match_preferences
       SET ranking = ranking || ARRAY['cost']::text[]
     WHERE NOT (ranking @> ARRAY['cost']::text[]);

    ALTER TABLE client_match_preferences
      ADD CONSTRAINT client_match_preferences_ranking_check CHECK (
        cardinality(ranking) = 4
        AND ranking @> ARRAY['quality','speed','cost','distance']::text[]
        AND ranking <@ ARRAY['quality','speed','cost','distance']::text[]
      );

    -- Opening hours and closures. NULL means the shop has not set its own and
    -- is scheduled against the platform default; it must never be read as
    -- "open at all times", which is how a Sunday promise gets made.
    ALTER TABLE supplier_profiles
      ADD COLUMN schedule jsonb;

    CREATE TABLE shop_reviews (
      id text PRIMARY KEY,
      order_id text NOT NULL UNIQUE REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      client_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      -- Three separate scores because they are three separate experiences, and
      -- an order that came out beautifully a day late should be able to say so.
      quality_stars smallint NOT NULL CHECK (quality_stars BETWEEN 1 AND 5),
      speed_stars smallint NOT NULL CHECK (speed_stars BETWEEN 1 AND 5),
      value_stars smallint NOT NULL CHECK (value_stars BETWEEN 1 AND 5),
      comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
      created_at timestamptz NOT NULL
    );

    CREATE INDEX shop_reviews_supplier_idx ON shop_reviews (supplier_id, created_at DESC, id);

    -- What the shop's own board promised, and when it actually finished. The
    -- pair is what an on-time record is computed from, and the shop is judged
    -- on its own date rather than the padded one the client was given.
    ALTER TABLE orders
      ADD COLUMN ready_by timestamptz,
      ADD COLUMN ready_at timestamptz;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN ready_at,
      DROP COLUMN ready_by;

    DROP TABLE shop_reviews;

    ALTER TABLE supplier_profiles DROP COLUMN schedule;

    ALTER TABLE client_match_preferences
      DROP CONSTRAINT client_match_preferences_ranking_check;

    UPDATE client_match_preferences
       SET ranking = array_remove(ranking, 'cost');

    ALTER TABLE client_match_preferences
      ADD CONSTRAINT client_match_preferences_ranking_check CHECK (
        cardinality(ranking) = 3
        AND ranking @> ARRAY['quality','speed','distance']::text[]
        AND ranking <@ ARRAY['quality','speed','distance']::text[]
      );
  `);
}
