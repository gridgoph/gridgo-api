/**
 * How a shop is paid across a job, one plan per version.
 *
 * Every figure here is a share of what GRIDGO pays the shop -- its own price,
 * less anything the client handed it directly -- and never of the client's
 * total. The client's service fee and the rider's delivery fee are not the
 * shop's money, so a percentage of them would pay a shop for work it never did.
 *
 * An order snapshots its plan version when the client commits to it, like the
 * rider split and the downpayment. Changing the current plan never reshapes an
 * order already placed: an older order keeps the stages it was sold under and
 * releases exactly as it always did.
 *
 * The database invariant (`validate_order_financial_children`) recomputes the
 * same shares per version. A new plan needs a new version here and a forward
 * migration there; editing a published plan in place would make every order
 * placed under it fail its own check.
 *
 * Contract: docs/OPERATIONAL_MODEL_V2_API.md#supplier-payout-milestones.
 */

const EVERY_STATE_FROM_PRODUCTION = Object.freeze([
  "production", "supplier_self_qc", "ready_for_dispatch", "rider_assigned",
  "picked_up", "out_for_delivery", "awaiting_collection", "delivered",
  "issue_window_open", "completed", "payout_released",
]);
const HANDED_TO_CLIENT = Object.freeze(["delivered", "issue_window_open", "completed", "payout_released"]);
const WINDOW_CLOSED = Object.freeze(["completed", "payout_released"]);

const DELIVERY_REFUSAL = Object.freeze({
  code: "delivery_required",
  message: "The client does not have this job yet. Record delivery or the counter hand-over first.",
});

/*
 Each stage names:
 - `shareBps`: its share of the shop's payout; the last stage takes the
   rounding remainder instead, so a plan always sums to exactly the payout.
 - `proofBy`: who attaches its Proof of Fulfilment (`supplier` or `rider`), or
   null when nothing is attached to it directly.
 - `requiresProof`: whether release refuses `pof_required` without a proof on
   the stage. Legacy retention holds the delivered proof it inherited.
 - `releaseRequires`: what the release desk waits on, as screens show it.
 - `states`/`refusal`: the order states it may be released in, and the refusal
   anywhere else.
*/
export const PAYOUT_PLANS = Object.freeze({
  /*
   The four stages orders were placed under before 25 Sep 2026: printing and
   packing on the shop's photographs, delivered on the rider's, and retention
   inheriting the delivered proof once the issue window closes -- the one stage
   the closing window still releases on its own.
  */
  1: Object.freeze({
    version: 1,
    stages: Object.freeze([
      Object.freeze({
        code: "printing", label: "Printing", shareBps: 5_000, proofBy: "supplier", requiresProof: true,
        releaseRequires: "shop_proof", states: EVERY_STATE_FROM_PRODUCTION,
        refusal: Object.freeze({
          code: "milestone_not_reached",
          message: "The shop has not started this job yet. Printing is released once production is under way.",
        }),
      }),
      Object.freeze({
        code: "packaging_qc", label: "Packaging", shareBps: 1_500, proofBy: "supplier", requiresProof: true,
        releaseRequires: "shop_proof", states: EVERY_STATE_FROM_PRODUCTION.slice(1),
        refusal: Object.freeze({
          code: "milestone_not_reached",
          message: "The job is not packed and ready for a rider yet. Packaging is released once it is.",
        }),
      }),
      Object.freeze({
        code: "delivered", label: "Delivered", shareBps: 2_500, proofBy: "rider", requiresProof: true,
        releaseRequires: "delivery_proof", states: HANDED_TO_CLIENT, refusal: DELIVERY_REFUSAL,
      }),
      Object.freeze({
        code: "retention", label: "Retention", shareBps: 1_000, proofBy: null, requiresProof: true,
        releaseRequires: "issue_window_closed", states: WINDOW_CLOSED,
        refusal: Object.freeze({
          code: "issue_window_open",
          message: "The client can still report a problem with this order. Retention is released once that window closes.",
        }),
      }),
    ]),
  }),

  /*
   The captain's escrow split, decided 25 Sep 2026 (gridgo-api#68, #73):
   40 percent when production starts, 35 on delivery, 25 once the complaint
   window has closed. Every stage is released by Operations or Super Admin;
   neither the clock nor the client's "everything is fine" pays anyone.
  */
  2: Object.freeze({
    version: 2,
    stages: Object.freeze([
      Object.freeze({
        code: "production_started", label: "Start of production", shareBps: 4_000, proofBy: "supplier", requiresProof: true,
        releaseRequires: "shop_proof", states: EVERY_STATE_FROM_PRODUCTION,
        refusal: Object.freeze({
          code: "milestone_not_reached",
          message: "The shop has not started this job yet. Start of production is released once production is under way.",
        }),
      }),
      Object.freeze({
        code: "delivered", label: "Delivered", shareBps: 3_500, proofBy: "rider", requiresProof: true,
        releaseRequires: "delivery_proof", states: HANDED_TO_CLIENT, refusal: DELIVERY_REFUSAL,
      }),
      Object.freeze({
        code: "issue_window", label: "Issue window closed", shareBps: 2_500, proofBy: null, requiresProof: false,
        releaseRequires: "issue_window_closed", states: WINDOW_CLOSED,
        refusal: Object.freeze({
          code: "issue_window_open",
          message: "The client can still report a problem with this order. The last share is released once that window closes.",
        }),
      }),
    ]),
  }),
});

/** The plan every new commitment snapshots. */
export const CURRENT_PAYOUT_PLAN_VERSION = 2;

/** An order with no stored version was placed under the four-stage plan. */
export const LEGACY_PAYOUT_PLAN_VERSION = 1;

export function payoutPlanVersionOf(order) {
  return Object.hasOwn(PAYOUT_PLANS, order?.payoutPlanVersion)
    ? order.payoutPlanVersion
    : LEGACY_PAYOUT_PLAN_VERSION;
}

export function payoutPlanFor(order) {
  return PAYOUT_PLANS[payoutPlanVersionOf(order)];
}

export function payoutStageFor(order, code) {
  return payoutPlanFor(order).stages.find((stage) => stage.code === code) || null;
}

/** Every stage code any plan has used, for words that outlive a plan. */
export function payoutStageLabel(code) {
  for (const plan of Object.values(PAYOUT_PLANS)) {
    const stage = plan.stages.find((candidate) => candidate.code === code);
    if (stage) return stage.label;
  }
  return "Payout";
}
