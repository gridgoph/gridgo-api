/** Internal voucher campaign purposes owned by the tester programme. Every one
 * counts against the monthly tester budget and is protected from generic
 * campaign edits. Kept dependency-free so the voucher core can import it. */
export const TESTER_CAMPAIGN_PURPOSES = Object.freeze(['founding_tester', 'tester_referral', 'tester_bug_report']);
