import { identityHasMembership } from './authorization-context.js';
import { voucherFail as fail } from './vouchers.js';
import { clientCartQuote } from './order-match-routes.js';
import { CHECKOUT_EXIT_QUESTION, CHECKOUT_EXIT_REASONS, recordCheckoutVisit, claimCheckoutExitPrompt, answerCheckoutExitPrompt,
  publicCheckoutExitPrompt, pricingFeedbackReport, checkoutExitReport } from './pricing-feedback.js';

const ADMIN = { '/admin/pricing-feedback': [pricingFeedbackReport, 'pricing-feedback.csv'],
  '/admin/checkout-exit-feedback': [checkoutExitReport, 'checkout-exit-feedback.csv'] };
export async function routePricingFeedback({ req, url, store, user, readBody, id, now }) {
  const path = url.pathname;
  const visit = /^\/me\/carts\/([^/]+)\/checkout-visit$/.exec(path);
  const answer = /^\/me\/checkout-exit-feedback\/([^/]+)$/.exec(path);
  if (!visit && !answer && !ADMIN[path]) return null;
  if (!user) fail(401, 'unauthorized');
  const at = now();
  if (ADMIN[path]) {
    if (!identityHasMembership(user, 'super_admin')) fail(403, 'forbidden');
    if (req.method !== 'GET') fail(404, 'not_found');
    const [report, filename] = ADMIN[path], result = report(store, url.searchParams);
    return result.bytes ? { status: 200, ...result, contentType: 'text/csv; charset=utf-8', filename } : { status: 200, body: { ...result, serverTime: at } };
  }
  if (!identityHasMembership(user, 'client')) fail(403, 'forbidden');
  if (req.method !== 'POST') fail(404, 'not_found');
  if (visit) {
    const cart = (store.carts || []).find(c => c.id === decodeURIComponent(visit[1]) && c.clientId === user.id);
    if (!cart) fail(404, 'cart_not_found');
    if (cart.state !== 'draft') fail(409, 'cart_checked_out');
    const lines = store.cartLines.filter(l => l.cartId === cart.id);
    if (!lines.length) fail(409, 'cart_empty');
    let totalMinor = null;
    try { totalMinor = clientCartQuote(store, cart, lines, at)?.totalMinor ?? null; } catch { /* an unpriced cart still counts as reached */ }
    const result = recordCheckoutVisit(store, cart, lines, { at, totalMinor });
    return { status: 200, body: { serverTime: at, visit: { cartId: cart.id, firstReachedAt: result.visit.firstReachedAt, lastReachedAt: result.visit.lastReachedAt } },
      mutated: result.changed };
  }
  if (answer[1] === 'prompt') {
    const result = claimCheckoutExitPrompt(store, user.id, { id, at });
    return { status: 200, body: { serverTime: at, question: CHECKOUT_EXIT_QUESTION, options: CHECKOUT_EXIT_REASONS,
      prompt: publicCheckoutExitPrompt(result.prompt), nextEligibleAt: result.nextEligibleAt }, mutated: result.changed };
  }
  const result = answerCheckoutExitPrompt(store, user.id, decodeURIComponent(answer[1]), await readBody(req), { id, at });
  return { status: 200, body: { serverTime: at, prompt: publicCheckoutExitPrompt(result.prompt) }, mutated: result.changed };
}
