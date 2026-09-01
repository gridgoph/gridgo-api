/**
 * Let a listing say what the shop actually charges.
 *
 * The catalogue could express one shape: a base price, options that each add a
 * flat amount, times a whole number of units or packs. That covers a stack of
 * flyers. Three of the five pilot shops price work it cannot state at all --
 * Polymedia bills tarpaulin by the square foot and plaques by the inch of
 * height, Jopal drops mugs from PHP 100 to PHP 60 at 250, and Lovis prices
 * hardbound entirely by how fast it is wanted. `src/pricing.js` has been able
 * to compute all of it since it landed; there was nowhere to store it.
 *
 * Everything here is optional. A listing selling flyers per pack of 100 sets a
 * unit and a price and meets none of it.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT supplier_catalog_items_pricing_unit_check;

    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_pricing_unit_check CHECK (
        pricing_unit IN ('per_unit', 'per_package', 'per_page', 'per_area', 'per_length', 'whole_job')
      ),
      -- The unit a shop states its measurements in. Area is that unit squared.
      ADD COLUMN measure_unit text CHECK (measure_unit IS NULL OR measure_unit IN ('mm','cm','in','ft','m')),
      -- Smallest size the shop will bill for, in thousandths of measure_unit.
      -- Waste is the same on a small job: Polymedia charges a 1x4 banner at the
      -- 2x4 rate, and being unable to say so means being underpaid on every one.
      ADD COLUMN minimum_width_milli integer CHECK (minimum_width_milli IS NULL OR minimum_width_milli > 0),
      ADD COLUMN minimum_height_milli integer CHECK (minimum_height_milli IS NULL OR minimum_height_milli > 0),
      ADD COLUMN minimum_length_milli integer CHECK (minimum_length_milli IS NULL OR minimum_length_milli > 0),
      -- Least the shop will run. Without it a client can pay for five of
      -- something a shop will not make, and the job dead-ends after checkout.
      ADD COLUMN minimum_order_quantity integer
        CHECK (minimum_order_quantity IS NULL OR minimum_order_quantity > 0);

    -- A measured unit cannot be priced without knowing what it is measured in.
    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_measure_unit_required_check CHECK (
        (pricing_unit IN ('per_area','per_length') AND measure_unit IS NOT NULL)
        OR (pricing_unit NOT IN ('per_area','per_length') AND measure_unit IS NULL)
      );

    -- Volume breaks. Bulk pricing is how these shops win large orders, and the
    -- catalogue could only hold one price per listing.
    CREATE TABLE supplier_catalog_price_tiers (
      id text PRIMARY KEY,
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      min_quantity integer NOT NULL CHECK (min_quantity > 0),
      unit_price_minor money_minor NOT NULL CHECK (unit_price_minor >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (catalog_item_id, min_quantity)
    );
    CREATE INDEX supplier_catalog_price_tiers_item_idx
      ON supplier_catalog_price_tiers (catalog_item_id, min_quantity);

    -- Speeds the shop sells, each with its own price. Lovis prices hardbound at
    -- PHP 250 for five days and PHP 700 for two hours: not a base price and a
    -- surcharge, but four prices for the same book. A flat fee is the other
    -- shape -- Pins On adds PHP 100 to rush an order of any size -- so a tier
    -- carries one or the other, never both.
    CREATE TABLE supplier_catalog_speed_tiers (
      id text PRIMARY KEY,
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 80),
      turnaround_hours integer NOT NULL CHECK (turnaround_hours > 0),
      price_minor money_minor CHECK (price_minor IS NULL OR price_minor >= 0),
      surcharge_minor money_minor CHECK (surcharge_minor IS NULL OR surcharge_minor >= 0),
      sort_order smallint NOT NULL CHECK (sort_order >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (catalog_item_id, turnaround_hours),
      CONSTRAINT supplier_catalog_speed_tiers_shape_check CHECK (
        (price_minor IS NOT NULL AND surcharge_minor IS NULL)
        OR (price_minor IS NULL AND surcharge_minor IS NOT NULL)
      )
    );
    CREATE INDEX supplier_catalog_speed_tiers_item_idx
      ON supplier_catalog_speed_tiers (catalog_item_id, turnaround_hours);

    -- An add-on that multiplies rather than adds. Lovis prices back-to-back as
    -- "x2 the price", which as a flat amount has to be re-entered by hand every
    -- time the base price moves. Basis points, so no float reaches the money.
    ALTER TABLE supplier_catalog_options
      ADD COLUMN price_multiplier_bps integer
        CHECK (price_multiplier_bps IS NULL OR price_multiplier_bps > 0),
      ADD CONSTRAINT supplier_catalog_options_price_shape_check CHECK (
        price_multiplier_bps IS NULL OR price_modifier_minor = 0
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_options
      DROP CONSTRAINT supplier_catalog_options_price_shape_check,
      DROP COLUMN price_multiplier_bps;

    DROP TABLE supplier_catalog_speed_tiers;
    DROP TABLE supplier_catalog_price_tiers;

    UPDATE supplier_catalog_items
       SET pricing_unit = 'per_unit', package_qty = NULL
     WHERE pricing_unit IN ('per_page', 'per_area', 'per_length', 'whole_job');

    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT supplier_catalog_items_measure_unit_required_check,
      DROP COLUMN minimum_order_quantity,
      DROP COLUMN minimum_length_milli,
      DROP COLUMN minimum_height_milli,
      DROP COLUMN minimum_width_milli,
      DROP COLUMN measure_unit;

    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT supplier_catalog_items_pricing_unit_check;

    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_pricing_unit_check CHECK (
        pricing_unit IN ('per_unit', 'per_package')
      );
  `);
}
