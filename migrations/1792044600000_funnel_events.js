export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE funnel_events (
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      client_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('product_viewed', 'listing_viewed', 'checkout_reached', 'paid', 'checkout_left')),
      order_id text,
      listing_id text,
      product_code text,
      exit_answer text
    );
    CREATE INDEX funnel_events_at ON funnel_events (at, id);
  `);
}

export async function down(pgm) {
  pgm.sql("DROP TABLE funnel_events");
}
