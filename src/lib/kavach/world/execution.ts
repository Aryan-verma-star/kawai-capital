/**
 * KAVACH — execution & market impact (Almgren-Chriss flavoured, always on).
 *
 * To trade value V of a bucket with current ADV A (₹) and price P:
 *   temporary cost  κ·(V/A)·V   (κ = 0.08, paid by the trader, in ₹)
 *   permanent shift γ·(V/A)     (γ = 0.01, moves the mid against the trader,
 *                                decays 0.90/day)
 *
 * Gate (spec): selling 20% of CRED's ADV in CRISIS must cost ≥ 1.5% of notional
 * in combined impact: 0.08×0.20 + 0.01×0.20 = 1.6% + 0.2% ⇒ 1.8% ≥ 1.5% ✓
 *
 * LIQ (TREPS / overnight) is exempt from impact — redeeming overnight liquid units
 * is frictionless; this is the settlement asset, not a market position.
 */

import { A3_PARTICIPATION_CAP, GAMMA, KAPPA } from '../constants';
import { BucketId } from '../types';

export interface ImpactQuote {
  participation: number;
  tempCost: number; // ₹
  permShift: number; // multiplicative price shift vs current mid
  combinedPct: number; // combined cost as fraction of notional
}

export function impactQuote(value: number, adv: number, direction: 1 | -1): ImpactQuote {
  const p = adv > 0 ? value / adv : 10; // pathological: ADV gone ⇒ participation explodes
  const tempCost = KAPPA * p * value;
  const permShift = GAMMA * p * direction; // buys push mid up, sells push it down
  return {
    participation: p,
    tempCost,
    permShift,
    combinedPct: KAPPA * p + GAMMA * p,
  };
}

/** Cap a desired trade value to A3 participation (10% of current ADV). */
export function capByParticipation(value: number, adv: number, cap = A3_PARTICIPATION_CAP): number {
  return Math.min(value, cap * Math.max(adv, 0));
}

export const LIQ_EXEMPT: BucketId = 'LIQ';

export function isImpactExempt(bucket: BucketId): boolean {
  return bucket === LIQ_EXEMPT;
}
