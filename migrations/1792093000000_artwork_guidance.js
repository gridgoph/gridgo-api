/**
 * Artwork guidance: per product type resolution and colour targets (a settings
 * value, bumped through the existing version handshake), the client's accepted
 * warnings on a cart line, and the immutable record checkout keeps per order line.
 */
const STARTING_GUIDANCE = {
  version: 1,
  default: { minimumDpi: 300, acceptsRgb: false },
  subcategories: {
    document_printing: { minimumDpi: 300, acceptsRgb: false },
    booklets: { minimumDpi: 300, acceptsRgb: false },
    risograph: { minimumDpi: 300, acceptsRgb: false },
    binding_hardbound: { minimumDpi: 300, acceptsRgb: false },
    id_photos: { minimumDpi: 300, acceptsRgb: false },
    flyers: { minimumDpi: 300, acceptsRgb: false },
    brochures: { minimumDpi: 300, acceptsRgb: false },
    business_cards: { minimumDpi: 300, acceptsRgb: false },
    stickers_packaging_labels: { minimumDpi: 300, acceptsRgb: false },
    certificates_diplomas: { minimumDpi: 300, acceptsRgb: false },
    corporate_giveaways: { minimumDpi: 300, acceptsRgb: false },
    drinkware: { minimumDpi: 300, acceptsRgb: false },
    lanyards_id_accessories: { minimumDpi: 300, acceptsRgb: false },
    plaques_trophies: { minimumDpi: 300, acceptsRgb: false },
    medals_ribbons: { minimumDpi: 300, acceptsRgb: false },
    packaging_box_production: { minimumDpi: 300, acceptsRgb: false },
    posters_standees: { minimumDpi: 200, acceptsRgb: false },
    custom_apparel: { minimumDpi: 150, acceptsRgb: true },
    tarpaulins_outdoor_banners: { minimumDpi: 100, acceptsRgb: false },
    business_store_signages: { minimumDpi: 100, acceptsRgb: false },
    blueprint_cad_plotting: { minimumDpi: 100, acceptsRgb: false },
    three_d_printing_scale_models: { minimumDpi: null, acceptsRgb: true },
  },
};

export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings
      SET settings = settings || jsonb_build_object('artworkGuidance', '${JSON.stringify(STARTING_GUIDANCE)}'::jsonb),
          version = version + 1
      WHERE NOT settings ? 'artworkGuidance';

    ALTER TABLE client_cart_lines ADD COLUMN artwork_warning_acceptances jsonb
      CHECK (artwork_warning_acceptances IS NULL OR (jsonb_typeof(artwork_warning_acceptances) = 'array'
        AND jsonb_array_length(artwork_warning_acceptances) <= 40));
    ALTER TABLE order_line_items ADD COLUMN artwork_guidance jsonb
      CHECK (artwork_guidance IS NULL OR (jsonb_typeof(artwork_guidance) = 'object'
        AND artwork_guidance->'version' = '1'::jsonb AND jsonb_typeof(artwork_guidance->'files') = 'array'));

    CREATE FUNCTION prevent_order_artwork_guidance_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.artwork_guidance IS DISTINCT FROM OLD.artwork_guidance THEN
        RAISE EXCEPTION 'order artwork guidance records are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_artwork_guidance_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_artwork_guidance_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_artwork_guidance_rewrite();
  `);
}
export async function down() {
  throw new Error('Artwork guidance records must be preserved; use a forward migration.');
}
