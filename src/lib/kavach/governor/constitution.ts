/**
 * KAVACH — the Constitution (M4.2). Hard constraints the governor enforces;
 * the optimizer proposes, the constitution disposes.
 *
 *  A1  LIQ ≥ 5% of NAV at all times (breachable only by scripted
 *      margin/redemption, never by choice)
 *  A2  Max 40% of GROSS exposure in any single bucket
 *  A3  Trade size ≤ 10% of current ADV per bucket per day (fire-sale brake)
 *  A4  Portfolio 1-day 95% CVaR ≤ 2.5% NAV (CALM) / 2.0% (STRESSED·RECOVERY)
 *      / 1.5% (CRISIS)
 *  A5  Unencumbered LIQ ≥ 2× projected next-day margin
 *  A6  LIQ ≥ max(5%, 3-day redemption pace)
 *  A7  LLM outputs may only tighten limits / raise severity / block trades —
 *      never loosen
 *  A8  Human overrides via consent cards with counterfactuals; all recorded
 *  A9  Radar unavailable in CRISIS → deterministic dictionary (fail-safe)
 *
 * Blocking semantics: the constitution is a ONE-WAY VALVE on risk. A2/A4 block
 * any proposal that would WORSEN concentration or CVaR; de-risking trades that
 * improve an already-breached book are always permitted (remediation), with the
 * article flagged "fired, remediation in progress". A3 blocks any trade above
 * the participation cap outright. A1/A5/A6 raise the LIQ floor the optimizer
 * must build toward — they cannot be fixed by refusing to sell.
 */

import { BUCKETS, BucketId, CONSTITUTION } from '../constants';
import { ConstitutionCheck, Regime } from '../types';

export type { ConstitutionCheck };

export interface ConstitutionContext {
  regime: Regime;
  nav: number;
  /** projected post-trade values per bucket (₹) */
  projectedValues: Record<BucketId, number>;
  /** projected unencumbered LIQ after trades (₹) */
  projectedLiq: number;
  /** proposed trades: participation vs current ADV */
  trades: { bucket: BucketId; value: number; participation: number }[];
  /** projected next-day margin requirement (₹) — conservative buffer */
  projectedMargin: number;
  /** 3-day redemption pace as a fraction of NAV */
  redemptionPace3d: number;
  /** was LIQ drained today by scripted margin/redemption flows? */
  scriptForcedToday: boolean;
  cvar95: number; // projected portfolio CVaR (fraction of NAV)
  /** pre-trade CVaR — A4 blocks deterioration, not remediation */
  preCvar95: number;
  /** pre-trade max bucket weight (of gross) — A2 blocks deterioration */
  preMaxWeight: number;
  radarProvider: string;
  overrideRecorded: boolean;
}

export function evaluateConstitution(ctx: ConstitutionContext): ConstitutionCheck[] {
  const checks: ConstitutionCheck[] = [];
  const nav = Math.max(ctx.nav, 1);
  const gross = Math.max(
    BUCKETS.reduce((a, b) => a + Math.max(ctx.projectedValues[b], 0), 0),
    1
  );

  // A1 — liquidity floor (script-forced breaches are flagged, not waived silently)
  const liqFrac = ctx.projectedLiq / nav;
  const a1Breached = liqFrac < CONSTITUTION.A1_LIQ_FLOOR;
  checks.push({
    article: 'A1',
    title: 'LIQ ≥ 5% NAV',
    passed: !a1Breached || ctx.scriptForcedToday,
    breached: a1Breached,
    detail: `LIQ ${(liqFrac * 100).toFixed(2)}% of NAV${a1Breached && ctx.scriptForcedToday ? ' (script-forced: margin/redemption)' : ''}`,
  });

  // A2 — bucket concentration (of GROSS exposure); blocks only deterioration
  let worst: { b: BucketId; w: number } | null = null;
  for (const b of BUCKETS) {
    const w = Math.max(ctx.projectedValues[b], 0) / gross;
    if (!worst || w > worst.w) worst = { b, w };
  }
  const worstW = worst?.w ?? 0;
  const a2Over = worstW > CONSTITUTION.A2_BUCKET_CAP + 1e-9;
  const a2Worsening = worstW > ctx.preMaxWeight + 1e-9;
  checks.push({
    article: 'A2',
    title: 'Max 40% of gross in any single bucket',
    passed: !a2Over || !a2Worsening,
    detail: a2Over
      ? `worst ${(worstW * 100).toFixed(1)}% (${worst!.b}) — ${a2Worsening ? 'worsening' : 'remediation in progress'}`
      : `worst ${(worstW * 100).toFixed(1)}% (${worst!.b})`,
  });

  // A3 — participation cap (hard block)
  const worstTrade = ctx.trades.reduce(
    (a, t) => (t.participation > (a?.participation ?? -1) ? t : a),
    null as null | { bucket: BucketId; value: number; participation: number }
  );
  checks.push({
    article: 'A3',
    title: 'Trade ≤ 10% of current ADV',
    passed: (worstTrade?.participation ?? 0) <= CONSTITUTION.A3_PARTICIPATION_CAP + 1e-9,
    detail: worstTrade
      ? `worst ${(worstTrade.participation * 100).toFixed(1)}% ADV (${worstTrade.bucket})`
      : 'no trades proposed',
  });

  // A4 — CVaR limit by regime; blocks deterioration, permits remediation
  const limit = CONSTITUTION.A4_CVAR_LIMITS[ctx.regime];
  const a4Over = ctx.cvar95 > limit + 1e-9;
  const a4Worsening = ctx.cvar95 > ctx.preCvar95 + 1e-9;
  checks.push({
    article: 'A4',
    title: `1-day 95% CVaR ≤ ${(limit * 100).toFixed(1)}% NAV (${ctx.regime})`,
    passed: !a4Over || !a4Worsening,
    detail: a4Over
      ? `CVaR ${(ctx.cvar95 * 100).toFixed(2)}% vs limit ${(limit * 100).toFixed(1)}% — ${a4Worsening ? 'worsening' : 'remediation in progress'}`
      : `CVaR ${(ctx.cvar95 * 100).toFixed(2)}% vs limit ${(limit * 100).toFixed(1)}%`,
  });

  // A5 — margin coverage
  const cover = ctx.projectedMargin > 0 ? ctx.projectedLiq / ctx.projectedMargin : Infinity;
  const coverStr = !isFinite(cover) || cover > 999 ? '∞' : cover.toFixed(2);
  checks.push({
    article: 'A5',
    title: 'LIQ ≥ 2× projected next-day margin',
    passed: cover >= CONSTITUTION.A5_MARGIN_COVER - 1e-9 || ctx.projectedMargin === 0,
    detail: `cover ${coverStr}×`,
  });

  // A6 — redemption pace
  const paceFloor = Math.max(CONSTITUTION.A1_LIQ_FLOOR, ctx.redemptionPace3d);
  checks.push({
    article: 'A6',
    title: 'LIQ ≥ max(5%, 3-day redemption pace)',
    passed: liqFrac >= paceFloor - 1e-9 || ctx.scriptForcedToday,
    detail: `floor ${(paceFloor * 100).toFixed(1)}%, LIQ ${(liqFrac * 100).toFixed(1)}%`,
  });

  // A7 — tighten-only radar (structural: the code path can only raise limits)
  checks.push({
    article: 'A7',
    title: 'LLM may only tighten — never loosen',
    passed: true,
    detail: 'radar pressure is a decaying max (raise-only)',
  });

  // A8 — overrides recorded
  checks.push({
    article: 'A8',
    title: 'Human overrides recorded w/ counterfactuals',
    passed: true,
    detail: ctx.overrideRecorded ? 'override trail present' : 'no overrides this session',
  });

  // A9 — fail-safe radar
  const a9Pass = !(ctx.regime === 'CRISIS' && ctx.radarProvider === 'llm-pending');
  checks.push({
    article: 'A9',
    title: 'Radar fail-safe (dictionary under stress)',
    passed: a9Pass,
    detail: `provider: ${ctx.radarProvider}`,
  });

  return checks;
}

/** Hard veto list: trades that may not execute under any autonomy level. */
export function blocksExecution(checks: ConstitutionCheck[]): ConstitutionCheck[] {
  return checks.filter((c) => !c.passed && (c.article === 'A2' || c.article === 'A3' || c.article === 'A4'));
}
