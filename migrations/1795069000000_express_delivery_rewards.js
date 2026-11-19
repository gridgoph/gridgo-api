/** Variable-value delivery rewards reuse the existing voucher funding/consumption boundary. */
export async function up(pgm) {
 pgm.sql(`
  ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_purpose_check;
  ALTER TABLE voucher_campaigns ADD CONSTRAINT voucher_campaigns_purpose_check CHECK
    (purpose IN ('manual','survey','founding_tester','tester_referral','founding_launch','friend_pass','tester_bug_report','express_friend_pass'));
  ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_value_minor_check;
  ALTER TABLE voucher_campaigns ADD CONSTRAINT voucher_campaigns_value_minor_check CHECK
    ((purpose='express_friend_pass' AND value_minor=0) OR (purpose<>'express_friend_pass' AND value_minor>0));
  ALTER TABLE vouchers DROP CONSTRAINT vouchers_value_minor_check;
  ALTER TABLE vouchers ADD CONSTRAINT vouchers_value_minor_check CHECK
    ((data @> '{"expressDeliveryReward":true}'::jsonb AND value_minor=0) OR
     (NOT data @> '{"expressDeliveryReward":true}'::jsonb AND value_minor>0));
 `);
}
export async function down() { throw new Error('Forward-only migration'); }
