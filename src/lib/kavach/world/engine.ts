/**
 * KAVACH — the world engine (M1).
 *
 * A deterministic, seeded daily simulator of a ₹1,000 Cr multi-asset Indian book:
 *  - regime-phased, correlated, zero-sum noise around scripted crisis paths
 *    (closes hit script targets exactly; noise gives the engine life)
 *  - the ADV liquidity mirage (phase multiplier, independent of price paths)
 *  - Almgren-Chriss impact, always on, with decaying permanent dislocation
 *  - two margin channels assessed on T-1 closes, called in cash at T open:
 *    MTF (ratio × borrowings vs EQ collateral + posted) and
 *    CCIL clearing (haircut × GSEC+IGCORP sleeve values)
 *  - a redemption tap; shortfalls force liquidations through the impact model —
 *    never silently waived
 *
 * Ledger truth: NAV ≡ cash + Σ units×price + postedMtf + postedCcil − borrowings.
 * This is an arithmetic identity recomputed from state every day; the recorder
 * logs the residual (it must be exactly 0 up to float noise).
 */

import {
  A3_PARTICIPATION_CAP,
  BOOK,
  BUCKETS,
  CCIL_BASE_HAIRCUT,
  CORR,
  CORR_ORDER,
  IMPACT_DECAY,
  LIQ_YIELD_PA,
  MTF_BORROWING_CR,
  MTF_INTEREST_PA,
  SEED,
  VOL_TABLE,
  WARMUP_DAYS,
  CR,
} from '../constants';
import { Rng, cholesky, streamRng, zeroSumNoise } from '../rng';
import {
  AgentMode,
  BucketId,
  MarginEvent,
  Phase,
  TradeRecord,
} from '../types';
import { ScenarioDef, scriptedDailyRets } from './scenarios';
import { capByParticipation, impactQuote, isImpactExempt } from './execution';

const NOISE_SCALE = 0.6; // noise vol around the scripted path (per-day, of regime vol)

export type LiquidationPolicy = 'naive' | 'governed' | 'world';

export interface DayEvents {
  day: number;
  marginEvents: MarginEvent[];
  redemption?: { day: number; amount: number; paid: number; shortfall: number };
  forcedSales: TradeRecord[];
  trades: TradeRecord[];
  ledgerResidual: number;
  prices: Record<BucketId, number>;
}

export class WorldEngine {
  readonly scenario: ScenarioDef;
  readonly seed: number;
  readonly mode: AgentMode;
  day = 0;

  clean: Record<BucketId, number>; // scripted × noise price path (no dislocation)
  prices: Record<BucketId, number>; // clean × disloc — traded marks
  units: Record<BucketId, number>;
  cash = 0;
  borrowings: number;
  postedMtf = 0;
  postedCcil = 0;
  disloc: Record<BucketId, number>;

  private noise: Record<BucketId, number[]>;
  lastMtfRatio: number;
  lastCcilHaircut: number;

  // cumulative stats
  impactPaid = 0;
  marginCumulative = 0;
  peakMarginCallDay = 0;
  forcedSaleEvents = 0;
  redemptionsMissed = 0;
  maxParticipation = 0;
  participationBreaches = 0; // days where any bucket trade > 10% ADV

  constructor(scenario: ScenarioDef, seed = SEED, mode: AgentMode = 'world') {
    this.scenario = scenario;
    this.seed = seed;
    this.mode = mode;

    this.clean = {} as Record<BucketId, number>;
    this.prices = {} as Record<BucketId, number>;
    this.units = {} as Record<BucketId, number>;
    this.disloc = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      const def = BOOK.find((x) => x.id === b)!;
      this.clean[b] = def.startPrice;
      this.prices[b] = def.startPrice;
      this.units[b] = (def.grossCr * CR) / def.startPrice;
      this.disloc[b] = 1.0;
    }
    this.borrowings = MTF_BORROWING_CR * CR;
    this.startPrices = {} as Record<BucketId, number>;
    for (const b of BUCKETS) this.startPrices[b] = BOOK.find((x) => x.id === b)!.startPrice;

    // Pre-generate the full noise field (agent-independent ⇒ determinism).
    this.noise = {} as Record<BucketId, number[]>;
    const days = scenario.days;
    for (const b of BUCKETS) {
      const rng = streamRng(`noise-${scenario.id}-${b}`, seed);
      const vols: number[] = [];
      for (let d = 1; d <= days; d++) {
        const phase = scenario.phaseAt(d);
        vols.push(VOL_TABLE[b][phase] * NOISE_SCALE);
      }
      this.noise[b] = zeroSumNoise(rng, days, vols);
    }
    // Day-0 CCIL posting (calm haircut on GSEC+IGCORP sleeve, funded from LIQ).
    const { ccilHaircut } = scenario.marginAt(0);
    const posting = ccilHaircut * (this.bucketValue('GSEC') + this.bucketValue('IGCORP'));
    this.redeemLiq(posting);
    this.cash -= posting;
    this.postedCcil = posting;
    this.lastCcilHaircut = ccilHaircut;
    this.lastMtfRatio = scenario.marginAt(0).mtfRatio;
  }

  // ---------- valuation ----------

  bucketValue(b: BucketId): number {
    return this.units[b] * this.prices[b];
  }

  /** Day-0 clean prices (calibration reference). */
  readonly startPrices: Record<BucketId, number>;

  nav(): number {
    let v = this.cash;
    for (const b of BUCKETS) v += this.bucketValue(b);
    v += this.postedMtf + this.postedCcil - this.borrowings;
    return v;
  }

  gross(): number {
    let v = 0;
    for (const b of BUCKETS) v += this.bucketValue(b);
    return v;
  }

  liqValue(): number {
    return this.bucketValue('LIQ');
  }

  adv(b: BucketId, day = this.day): number {
    const def = BOOK.find((x) => x.id === b)!;
    const d = Math.min(day, this.scenario.days);
    return def.calmAdvCr * CR * this.scenario.advMultAt(d) * this.scenario.bucketAdvMult(b, d);
  }

  phase(): Phase {
    return this.scenario.phaseAt(Math.min(this.day, this.scenario.days));
  }

  ledgerResidual(): number {
    const lhs = this.nav();
    let rhs = this.cash + this.postedMtf + this.postedCcil - this.borrowings;
    for (const b of BUCKETS) rhs += this.units[b] * this.prices[b];
    return Math.abs(lhs - rhs);
  }

  // ---------- cash & LIQ plumbing ----------

  /** Redeem LIQ units for cash at the current LIQ price (frictionless, TREPS). */
  redeemLiq(amount: number): number {
    const avail = Math.min(amount, this.liqValue());
    if (avail <= 0) return 0;
    this.units['LIQ'] -= avail / this.prices['LIQ'];
    this.cash += avail;
    return avail;
  }

  /** Park excess cash into LIQ (sweep); keep the settlement buffer small. */
  sweepCashToLiq(): void {
    if (this.cash > 1e6) {
      this.units['LIQ'] += this.cash / this.prices['LIQ'];
      this.cash = 0;
    }
  }

  /**
   * Raise `amount` of cash: settlement cash → LIQ redemption → forced liquidation
   * through the impact model. Never silently waived. Policy:
   *  - naive:    pro-rata across risk buckets (no participation cap — the villain)
   *  - governed: waterfall by ADV (most liquid first), chunks capped at 10% ADV;
   *              only breaches the cap if the call mathematically cannot be met
   *  - world:    LIQ only (frozen book — calibration mode)
   */
  raiseCash(amount: number, policy: LiquidationPolicy, reason: string): TradeRecord[] {
    const sales: TradeRecord[] = [];
    let need = amount - this.cash;
    this.redeemLiq(Math.max(0, need));
    need = amount - this.cash;
    if (need <= 1) return sales;

    const riskBuckets = ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD'] as BucketId[];
    if (policy === 'world') return sales; // frozen book: shortfall recorded upstream

    if (policy === 'naive') {
      // pro-rata across risk buckets — sells CRED/IGCORP into collapsed ADV
      const riskVal = riskBuckets.reduce((a, b) => a + this.bucketValue(b), 0);
      if (riskVal <= 0) return sales;
      for (const b of riskBuckets) {
        const share = this.bucketValue(b) / riskVal;
        const want = Math.min(need * share, this.bucketValue(b) * 0.9);
        if (want > 1e4) {
          const t = this.execute(b, want, -1, `forced:${reason}`, false);
          if (t) sales.push(t);
        }
      }
    } else {
      // governed: pass 1 — waterfall by ADV (most liquid first), every chunk
      // within 10% ADV (A3). Pass 2 only if ALL buckets at caps cannot cover
      // the need: an uncapped, recorded constitutional exception (last resort).
      const order = [...riskBuckets].sort((a, b) => this.adv(b) - this.adv(a));
      for (const b of order) {
        need = amount - this.cash;
        if (need <= 1) break;
        const want = Math.min(need, this.bucketValue(b) * 0.9);
        const capped = capByParticipation(want, this.adv(b));
        if (capped > 1e4) {
          const t = this.execute(b, capped, -1, `forced:${reason}`, false);
          if (t) sales.push(t);
        }
      }
      need = amount - this.cash;
      if (need > 1) {
        for (const b of order) {
          need = amount - this.cash;
          if (need <= 1) break;
          const want = Math.min(need, this.bucketValue(b) * 0.9);
          if (want > 1e4) {
            const t = this.execute(b, want, -1, `forced-breach:${reason}`, true);
            if (t) sales.push(t);
          }
        }
      }
    }
    return sales;
  }

  // ---------- trading ----------

  /**
   * Execute a trade of `value` (₹ notional) in `bucket`. Applies temporary impact
   * (paid in cash) and a permanent mid dislocation (decays 0.90/day).
   * Returns null if nothing to trade.
   */
  execute(
    bucket: BucketId,
    value: number,
    direction: 1 | -1,
    reason: string,
    allowedBreach = false
  ): TradeRecord | null {
    if (value <= 1) return null;
    if (bucket !== 'LIQ') {
      const val = this.bucketValue(bucket);
      if (direction === -1 && value > val) value = val;
    }
    const price = this.prices[bucket];
    const adv = this.adv(bucket);
    const q = isImpactExempt(bucket)
      ? { participation: 0, tempCost: 0, permShift: 0 }
      : impactQuote(value, adv, direction);

    // cash settlement: buys debit value + temp cost; sells credit value − temp cost
    this.cash -= direction * value + q.tempCost;
    this.units[bucket] += (direction * value) / price;

    if (!isImpactExempt(bucket)) {
      this.disloc[bucket] *= 1 + q.permShift;
      this.prices[bucket] = this.clean[bucket] * this.disloc[bucket];
      this.impactPaid += q.tempCost;
      this.maxParticipation = Math.max(this.maxParticipation, q.participation);
      if (q.participation > A3_PARTICIPATION_CAP) this.participationBreaches++;
    } else {
      // LIQ: frictionless, price is the accrual path
    }

    return {
      day: this.day,
      bucket,
      value,
      direction,
      participation: q.participation,
      tempCost: q.tempCost,
      permShift: q.permShift,
      reason,
    };
  }

  repayBorrowing(amount: number): number {
    const pay = Math.max(0, Math.min(amount, this.borrowings, this.cash));
    this.borrowings -= pay;
    this.cash -= pay;
    return pay;
  }

  // ---------- the day cycle ----------

  /** Morning of day d: interest, margin calls, releases, redemptions. */
  stepOpen(d: number, policy: LiquidationPolicy): DayEvents {
    this.day = d;
    const events: DayEvents = {
      day: d,
      marginEvents: [],
      forcedSales: [],
      trades: [],
      ledgerResidual: 0,
      prices: { ...this.prices },
    };

    // 1) MTF interest accrual, paid in cash
    const interest = (this.borrowings * MTF_INTEREST_PA) / 250;
    if (this.cash < interest) this.redeemLiq(interest - this.cash);
    this.cash -= interest;

    // 2) Margin assessed on T-1 closes (state is still at T-1 marks here)
    const { mtfRatio, ccilHaircut } = this.scenario.marginAt(d);
    const eqVal = this.bucketValue('EQ');
    const mtfReq = mtfRatio * this.borrowings;
    const mtfCall = Math.max(0, mtfReq - (eqVal + this.postedMtf));
    const ccilReq = ccilHaircut * (this.bucketValue('GSEC') + this.bucketValue('IGCORP'));
    const ccilCall = Math.max(0, ccilReq - this.postedCcil);

    const ratioDropped = mtfRatio < this.lastMtfRatio - 1e-9;
    const haircutDropped = ccilHaircut < this.lastCcilHaircut - 1e-9;

    for (const channel of ['MTF', 'CCIL'] as const) {
      const call = channel === 'MTF' ? mtfCall : ccilCall;
      const req = channel === 'MTF' ? mtfReq : ccilReq;
      const dropped = channel === 'MTF' ? ratioDropped : haircutDropped;
      const postedBefore = channel === 'MTF' ? this.postedMtf : this.postedCcil;
      let released = 0;
      if (dropped) {
        const excess = Math.max(0, postedBefore - req);
        if (excess > 0) {
          released = excess;
          if (channel === 'MTF') this.postedMtf -= released;
          else this.postedCcil -= released;
          this.cash += released;
        }
      }
      if (call > 1) {
        const cashBefore = this.cash;
        let sales: TradeRecord[] = [];
        if (channel === 'CCIL') {
          // clearing margin: the fund's choice what to sell (policy-dependent)
          sales = this.raiseCash(call, policy, `margin-${channel}`);
        } else {
          // MTF: pay from cash → LIQ; if short, the LENDER enforces on the
          // EQ collateral (sells through impact, repays borrowing) — the
          // March-2020 story, bounded so the spiral cannot run to infinity.
          this.redeemLiq(Math.max(0, call - this.cash));
          const shortfall = call - this.cash;
          if (shortfall > 1) {
            const eqVal = this.bucketValue('EQ');
            const enforceSell = Math.min(shortfall, eqVal * 0.9);
            if (enforceSell > 1e4) {
              const t = this.execute('EQ', enforceSell, -1, `lender-enforcement`, true);
              if (t) sales.push(t);
              this.repayBorrowing(Math.min(Math.max(0, this.cash), enforceSell));
            }
            // enforcement squares off the requirement; residual recorded
          }
        }
        const paid = Math.min(this.cash, call);
        this.cash -= paid;
        if (channel === 'MTF') this.postedMtf += paid;
        else this.postedCcil += paid;
        this.marginCumulative += call;
        this.peakMarginCallDay = Math.max(this.peakMarginCallDay, call);
        const paidFromCash = Math.min(cashBefore, paid);
        const paidFromLiq = Math.max(0, paid - paidFromCash);
        events.marginEvents.push({
          day: d,
          channel,
          callAmount: call,
          paidFromCash,
          paidFromLiq,
          forcedSale: sales.reduce((a, s) => a + s.value, 0),
          released,
          requirement: req,
          posted: channel === 'MTF' ? this.postedMtf : this.postedCcil,
        });
        events.forcedSales.push(...sales);
        if (sales.length > 0) this.forcedSaleEvents += sales.length;
      } else if (released > 0) {
        events.marginEvents.push({
          day: d,
          channel,
          callAmount: 0,
          paidFromCash: 0,
          paidFromLiq: 0,
          forcedSale: 0,
          released,
          requirement: req,
          posted: channel === 'MTF' ? this.postedMtf : this.postedCcil,
        });
      }
    }
    this.lastMtfRatio = mtfRatio;
    this.lastCcilHaircut = ccilHaircut;

    // 3) Redemption tap (the Franklin story)
    const tap = this.scenario.redemptions.find((r) => r.day === d);
    if (tap) {
      const navYesterday = this.nav(); // T-1 marks
      const amount = tap.pctOfAum * navYesterday;
      const sales = this.raiseCash(amount, policy, 'redemption');
      const paid = Math.min(this.cash, amount);
      this.cash -= paid;
      if (paid < amount - 1) this.redemptionsMissed++;
      events.redemption = { day: d, amount, paid, shortfall: amount - paid };
      events.forcedSales.push(...sales);
      if (sales.length > 0) this.forcedSaleEvents += sales.length;
    }

    return events;
  }

  /** Close of day d: price evolution (scripted + noise + decaying dislocation). */
  stepClose(d: number): Record<BucketId, number> {
    for (const b of BUCKETS) {
      if (b === 'LIQ') {
        const liqNoise = this.noise['LIQ'][d - 1];
        this.clean['LIQ'] *= 1 + LIQ_YIELD_PA / 250 + liqNoise;
        this.disloc['LIQ'] = 1;
        this.prices['LIQ'] = this.clean['LIQ'];
        continue;
      }
      const scripted = scriptedDailyRets(this.scenario.anchors[b] ?? [], d);
      const noise = this.noise[b][d - 1];
      this.clean[b] *= 1 + scripted + noise;
      this.disloc[b] = 1 + (this.disloc[b] - 1) * IMPACT_DECAY;
      this.prices[b] = this.clean[b] * this.disloc[b];
    }
    this.sweepCashToLiq();
    return this.prices;
  }

  /** Yesterday's bucket returns (for metrics). */
  dailyRets(): Record<BucketId, number> {
    const out = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      out[b] = 0; // filled by SimSession which tracks prior prices
    }
    return out;
  }
}

/** Warm-up history: 250 days of calm-regime correlated returns (estimators only). */
export function warmupReturns(scenario: ScenarioDef, seed = SEED): Record<BucketId, number[]> {
  const rng = streamRng(`warmup-${scenario.id}`, seed);
  const L = cholesky(CORR['CALM']);
  const out = {} as Record<BucketId, number[]>;
  for (const b of BUCKETS) out[b] = [];
  for (let d = 0; d < WARMUP_DAYS; d++) {
    const u = Array.from({ length: 6 }, () => rng.normal());
    const z = L.map((row) => row.reduce((a, l, j) => a + l * u[j], 0));
    CORR_ORDER.forEach((b, i) => {
      out[b].push(z[i] * VOL_TABLE[b]['CALM']);
    });
  }
  return out;
}

export function newRng(seed: number): Rng {
  return new Rng(seed);
}
