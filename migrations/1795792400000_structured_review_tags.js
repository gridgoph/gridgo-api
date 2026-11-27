/** Structured review tags; all original scores, comments and timestamps survive. */
export async function up(pgm) {
  pgm.sql(String.raw`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    ALTER TABLE shop_reviews ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
    CREATE FUNCTION valid_shop_review_tags(tags text[], stars integer) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT tags IS NOT NULL AND array_position(tags, NULL) IS NULL
        AND cardinality(tags) <= 6
        AND cardinality(tags) = (SELECT count(DISTINCT tag) FROM unnest(tags) AS t(tag))
        AND tags <@ CASE WHEN stars >= 4 THEN
          ARRAY['Accepted fast','Clear print','Ready on time','Friendly','Good value','Easy to find']
          ELSE ARRAY['Faded print','Wrong settings','Slow to accept','Not ready on time','Rude','Hard to find'] END
    $$;
    ALTER TABLE shop_reviews ADD CONSTRAINT shop_reviews_tags_check
      CHECK (valid_shop_review_tags(tags, quality_stars::integer));
    WITH tag_lines AS (
      SELECT r.id, r.quality_stars, min(substr(line,7)) AS tag_text
      FROM shop_reviews r
      CROSS JOIN LATERAL regexp_split_to_table(r.comment, E'\\r?\\n') AS t(line)
      WHERE left(line,6)='Tags: '
      GROUP BY r.id,r.quality_stars HAVING count(*)=1
    ), candidates AS (
      SELECT r.id, r.quality_stars, extracted.tags
      FROM tag_lines r
      CROSS JOIN LATERAL (
        SELECT array_agg(tag ORDER BY first_position) AS tags FROM (
          SELECT btrim(value) AS tag, min(position) AS first_position
          FROM regexp_split_to_table(r.tag_text, '[,·]') WITH ORDINALITY AS t(value,position)
          GROUP BY btrim(value)
        ) unique_tags
      ) extracted
    )
    UPDATE shop_reviews r SET tags = c.tags FROM candidates c
      WHERE r.id=c.id AND valid_shop_review_tags(c.tags,c.quality_stars::integer);
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
