/**
 * Words for money that moved.
 *
 * Shared by the manual release route and the derived payout events so a shop
 * and Operations read the same stage name and the same figure wherever the
 * release happened.
 */

/** Peso, as a person writes it. Minor units in, one figure out. */
export function formatMinorPhp(amountMinor) {
  const pesos = Math.trunc(Math.abs(amountMinor) / 100);
  const centavos = String(Math.abs(amountMinor) % 100).padStart(2, "0");
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}₱${pesos.toLocaleString("en-PH")}.${centavos}`;
}

/** What the shop calls each stage. Never the platform's own code. */
export function payoutStageLabel(code) {
  return ({
    printing: "Printing",
    packaging_qc: "Packaging",
    delivered: "Delivered",
    retention: "Retention",
  })[code] || "Payout";
}
