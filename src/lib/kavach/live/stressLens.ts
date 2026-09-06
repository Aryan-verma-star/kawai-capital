/**
 * KAVACH — Stress Lens (what-if pre-mortem) for the LIVE paper book.
 *
 * Projects today's actual sleeve values through a scripted crisis path
 * (TANTRUM-13 / ILFS-18 / COVID-20) as a pure BUY-AND-HOLD counterfactual:
 * no rebalancing, no forced sales, no constitution action. It answers the
 * desk question "if 2013 happened to this book tomorrow and we did nothing,
 * what survives?" — the counterfactual the governed bot is measured against.
 *
 * Honesty rules (this is a lens, not a prediction):
 *  - EQ/GOLD scripted anchors are historical INR paths; bonds are
 *    yield/spread model factors (same mark-to-model as the LIVE book).
 *  - Verdicts re-use the constitution's limits (A4 CVaR, A1 LIQ floor,
 *    desk stop) as *reference lines on the unmanaged path* — the real
 *    constitution runs pre-trade on the managed loop and would have cut
 *    risk along the way. The lens deliberately does not model that.
 *  - Pure function of (book, crisis): deterministic, offline, testable.
 */

import { BUCKETS, BucketId, CONSTITUTION, CR, MTF_INTEREST_PA } from '../constants';
import { CrisisId, SCENARIOS, scenarioScriptedRets } from '../world/scenarios';
import { LIVE_LIQ_YIELD_PA } from './paperBook';

/** The desk-stop drawdown used by the REPLAY risk strip (−10%). */
export const DESK_STOP_DD = 0.1;

export interface StressVerdict {
  article: string;
  title: string;
  passed: boolean;
  breachDay: number | null;
  detail: string;
}

export interface StressLensResult {
  scenario: CrisisId;
  title: string;
  story: string;
  days: number;
  /** day 0 = today (current values); day N = scripted close. */
  path: { day: number; nav: number; dd: number }[];
  navStartCr: number;
  navEndCr: number;
  maxDrawdown: number;
  worstDay: number;
  /** tail mean of daily portfolio losses over the window (α = 0.95, same semantics as the metrics engine) */
  cvar95: number;
  sleeveCum: Record<BucketId, number>;
  worstSleeve: { bucket: BucketId; ret: number } | null;
  verdicts: StressVerdict[];
  honest: string;
}

export interface StressBook {
  values: Record<BucketId, number>; // ₹, current sleeve values
  cash: number; // ₹
  borrowings: number; // ₹ MTF (accrues interest, never force-sold in the lens)
}

const RISK_BUCKETS: Exclude<BucketId, 'LIQ'>[] = ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD'];

export function stressLens(book: StressBook, crisis: CrisisId): StressLensResult {
  const sc = SCENARIOS[crisis];
  const days = sc.days;

  const rets: Record<BucketId, number[]> = {} as Record<BucketId, number[]>;
  for (const b of RISK_BUCKETS) rets[b] = scenarioScriptedRets(sc, b, days);
  rets.LIQ = Array.from({ length: days }, () => LIVE_LIQ_YIELD_PA / 365);

  const v0: Record<BucketId, number> = {} as Record<BucketId, number>;
  for (const b of BUCKETS) v0[b] = Math.max(book.values[b] ?? 0, 0);

  const path: { day: number; nav: number; dd: number }[] = [];
  const dailyRets: number[] = [];

  let v = { ...v0 };
  let cash = book.cash;
  let borr = book.borrowings;
  const nav0 = BUCKETS.reduce((a, b) => a + v[b], 0) + cash - borr;
  let peak = nav0;
  path.push({ day: 0, nav: nav0, dd: 0 });

  for (let d = 1; d <= days; d++) {
    const vPrev = { ...v };
    for (const b of BUCKETS) v[b] = vPrev[b] * (1 + rets[b][d - 1]);
    cash += Math.max(cash, 0) * (LIVE_LIQ_YIELD_PA / 365); // idle cash sweeps TREPS-style
    borr *= 1 + MTF_INTEREST_PA / 365;
    const nav = BUCKETS.reduce((a, b) => a + v[b], 0) + cash - borr;
    peak = Math.max(peak, nav);
    path.push({ day: d, nav, dd: nav / peak - 1 });
    dailyRets.push(nav / path[d - 1].nav - 1);
  }

  const navEnd = path[path.length - 1].nav;
  let maxDrawdown = 0;
  let worstDay = 0;
  let worstDayIdx = 0;
  dailyRets.forEach((r, i) => {
    maxDrawdown = Math.min(maxDrawdown, path[i + 1].dd);
    if (r < worstDay) {
      worstDay = r;
      worstDayIdx = i + 1;
    }
  });

  // CVaR α=0.95 — tail mean of losses, same interpolation as the metrics engine
  const tail = 0.05 * dailyRets.length;
  const losses = dailyRets.map((r) => -r).sort((a, b) => b - a);
  const k = Math.floor(tail);
  let sum = 0;
  for (let i = 0; i < Math.min(k, losses.length); i++) sum += losses[i];
  if (k < losses.length) sum += (tail - k) * losses[k];
  const cvar95 = tail > 0 ? sum / tail : 0;

  const sleeveCum = {} as Record<BucketId, number>;
  for (const b of BUCKETS) {
    let c = 1;
    for (const r of rets[b]) c *= 1 + r;
    sleeveCum[b] = c - 1;
  }
  let worstSleeve: { bucket: BucketId; ret: number } | null = null;
  for (const b of RISK_BUCKETS) {
    if (!worstSleeve || sleeveCum[b] < worstSleeve.ret) worstSleeve = { bucket: b, ret: sleeveCum[b] };
  }

  // ---- reference verdicts (limits re-used as lenses on the unmanaged path)
  const verdicts: StressVerdict[] = [];

  const ddBreachDay = path.findIndex((p) => p.dd <= -DESK_STOP_DD);
  verdicts.push({
    article: 'STOP',
    title: 'Desk stop — max drawdown',
    passed: maxDrawdown > -DESK_STOP_DD,
    breachDay: ddBreachDay > 0 ? ddBreachDay : null,
    detail:
      maxDrawdown > -DESK_STOP_DD
        ? `Unmanaged path bottoms at ${pctStr(maxDrawdown)}, inside the −10% desk stop.`
        : `Unmanaged path hits the −10% desk stop on day ${ddBreachDay} (bottom ${pctStr(maxDrawdown)}). A live desk would be flat; the governed bot ratchets down long before.`,
  });

  const crisisLimit = CONSTITUTION.A4_CVAR_LIMITS.CRISIS;
  verdicts.push({
    article: 'A4',
    title: 'CVaR 95 vs CRISIS limit',
    passed: cvar95 <= crisisLimit,
    breachDay: null,
    detail: `Unmanaged tail loss ${pctStr(cvar95)} per day vs the constitution's tightest (CRISIS) limit ${pctStr(crisisLimit)} — the pre-trade A4 gate would block trades that push live risk anywhere near this.`,
  });

  const liqEnd = v.LIQ + cash;
  const liqWeightEnd = navEnd > 0 ? liqEnd / navEnd : 0;
  verdicts.push({
    article: 'A1',
    title: 'Post-stress LIQ + cash floor',
    passed: liqWeightEnd >= CONSTITUTION.A1_LIQ_FLOOR,
    breachDay: null,
    detail: `At the scripted close, LIQ + cash is ${(liqWeightEnd * 100).toFixed(1)}% of NAV vs the 5% A1 floor — ${liqWeightEnd >= CONSTITUTION.A1_LIQ_FLOOR ? 'the book would still meet redemptions' : 'the book would be selling locked sleeves to fund exits'}.`,
  });

  if (worstSleeve) {
    verdicts.push({
      article: 'WORST',
      title: 'Worst sleeve',
      passed: true,
      breachDay: null,
      detail: `${worstSleeve.bucket} takes ${pctStr(sleeveCum[worstSleeve.bucket])} cumulatively on the scripted path${worstDayIdx ? `; worst single day ${pctStr(worstDay)} (day ${worstDayIdx})` : ''}.`,
    });
  }

  return {
    scenario: crisis,
    title: sc.title,
    story: sc.story,
    days,
    path,
    navStartCr: nav0 / CR,
    navEndCr: navEnd / CR,
    maxDrawdown,
    worstDay,
    cvar95,
    sleeveCum,
    worstSleeve,
    verdicts,
    honest:
      'Counterfactual buy-and-hold projection: no rebalancing, no forced sales, no constitution action, no market impact. Bond sleeves follow the same mark-to-model factors as the LIVE book. The governed loop exists precisely because this path is what it refuses to ride.',
  };
}

function pctStr(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
