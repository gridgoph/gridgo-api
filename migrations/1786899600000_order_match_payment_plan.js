export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders
      DROP CONSTRAINT orders_payment_plan_check,
      DROP CONSTRAINT orders_supplier_downpayment_rate_bps_check,
      DROP CONSTRAINT orders_money_model_version_check;

    ALTER TABLE orders
      ADD CONSTRAINT orders_payment_plan_check CHECK (payment_plan IN (
        'delivery_online','pickup_full_online','pickup_downpayment_store','order_match_qr_75_25'
      )),
      ADD CONSTRAINT orders_supplier_downpayment_rate_bps_check CHECK (
        supplier_downpayment_rate_bps IN (0,2500,5000,7500,10000)
      ),
      ADD CONSTRAINT orders_money_model_version_check CHECK (money_model_version IN (1,2,3));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE orders DISABLE TRIGGER orders_committed_money_immutable_trigger;
    UPDATE orders
       SET payment_plan = NULL,
           supplier_downpayment_rate_bps = NULL,
           commercial_committed_at = NULL,
           money_model_version = 2
     WHERE money_model_version = 3 OR payment_plan = 'order_match_qr_75_25';
    SET CONSTRAINTS ALL IMMEDIATE;
    ALTER TABLE orders ENABLE TRIGGER orders_committed_money_immutable_trigger;

    ALTER TABLE orders
      DROP CONSTRAINT orders_payment_plan_check,
      DROP CONSTRAINT orders_supplier_downpayment_rate_bps_check,
      DROP CONSTRAINT orders_money_model_version_check;

    ALTER TABLE orders
      ADD CONSTRAINT orders_payment_plan_check CHECK (payment_plan IN (
        'delivery_online','pickup_full_online','pickup_downpayment_store'
      )),
      ADD CONSTRAINT orders_supplier_downpayment_rate_bps_check CHECK (
        supplier_downpayment_rate_bps IN (0,2500,5000,10000)
      ),
      ADD CONSTRAINT orders_money_model_version_check CHECK (money_model_version IN (1,2));
  `);
}
