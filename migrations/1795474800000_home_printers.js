/** Nullable metadata preserves the exact legacy supplier-profile upsert shape. */
export async function up(pgm) {
 pgm.addColumns('supplier_profiles', {home_printer:{type:'jsonb'}});
 // Earlier guided signup accepted the kind without private-pin policy. Fail
 // closed until these accounts explicitly consent and receive Starter review.
 pgm.sql(`UPDATE supplier_profiles p SET home_printer=jsonb_build_object(
   'barangay','Barangay unavailable','street',p.shop_label,
   'startedAt',COALESCE(m.created_at,s.updated_at),'online',false,'consecutiveMisses',0)
   FROM supplier_signups s JOIN user_role_memberships m ON m.user_id=s.supplier_id AND m.role='supplier'
   WHERE p.home_printer IS NULL AND s.supplier_id=p.user_id AND s.steps#>>'{eligibility,shopKind}'='home_printer';`);
}
export async function down() { throw new Error('Forward-only migration'); }
