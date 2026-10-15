const fields = { order_id: 'orderId', client_id: 'clientId', completed_at: 'completedAt', opened_at: 'openedAt', expires_at: 'expiresAt',
  fulfillment_kind: 'fulfillmentKind', notified_at: 'notifiedAt', dismissed_at: 'dismissedAt', submitted_at: 'submittedAt',
  fulfillment_stars: 'fulfillmentStars', ease_stars: 'easeStars', price_feeling: 'priceFeeling', expected_price_minor: 'expectedPriceMinor',
  quality_stars: 'qualityStars', recommend_score: 'recommendScore', improvement_note: 'improvementNote',
  direct_shop_comparison: 'directShopComparison', price_worth_tags: 'priceWorthTags', order_again_at_price: 'orderAgainAtPrice',
  fulfillment_tags: 'fulfillmentTags', ease_tags: 'easeTags', needs_follow_up: 'needsFollowUp', reward_status: 'rewardStatus', reward_voucher_id: 'rewardVoucherId' };
export const surveyTable = { name: 'order_surveys', keys: ['order_id'], columns: Object.keys(fields) };
export function surveyRows(store, rows) {
  rows.order_surveys = (store.orderSurveys || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql,
    js.endsWith('Tags') ? JSON.stringify(item[js] || []) : item[js] ?? (js === 'needsFollowUp' ? false : null)])));
}
export function loadSurveyRows(store, rows) {
  store.orderSurveys = rows.order_surveys.map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
