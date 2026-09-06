/**
 * KAVACH — risk metrics (M2).
 *
 *  - EWMA volatility (λ = 0.94, RiskMetrics 1996), 60-day minimum history is
 *    guaranteed by a 250-day calm warm-up that precedes day 0.
 *  - CVaR / Expected Shortfall, 95%, 1-day, via the Rockafellar-Uryasev (2000)
 *    formulation. For a discrete scenario set the RU optimum is exactly the
 *    tail average: take the worst ⌈(1−α)·N⌉ losses with fractional weight —
 *    the same scenario set serves both the metric and the optimizer constraint.
 *  - Drawdown series (Grossman-Zhou 1993 awareness; optimal G&Z control is a
 *    cited stretch goal, not implemented).
 *  - FRTB-flavoured liquidity horizon: days-to-liquidate = value / (participation
 *    rate × ADV) at CURRENT ADV; portfolio horizon = Σ wᵢ·daysᵢ. This is the
 *    number that explodes in CRISIS and motivates the constitution.
 *  - Stress gate: shadow replay of the COVID-20 script applied to current weights.
 *
 * Regulatory note: Basel FRTB moved VaR → Expected Shortfall and RBI's FRTB
 * directions do the same; A4 therefore limits CVaR, not VaR.
 */

import { BUCKETS, BucketId, CONSTITUTION, CORR, CORR_ORDER, VOL_TABLE } from '../constants';
import { cholesky, streamRng } from '../rng';
import { Regime } from '../types';
import { COVID20, ScenarioDef, scenarioScriptedRets } from '../world/scenarios';

export const EWMA_LAMBDA = 0.94;
export const CVAR_ALPHA = 0.95;

export interface LiquiditySnapshot {
  perBucket: Record<BucketId, number>; // days to liquidate
  portfolioDays: number; // Σ wᵢ·daysᵢ
}

export interface StressResult {
  terminalDrawdown: number; // negative
  worstDayLoss: number; // positive fraction of initial NAV
  passesA4: boolean;
  passesDdCap: boolean;
}

export class MetricsEngine {
  private rets: Record<BucketId, number[]>;
  portfolioRets: number[];
  /** Benchmark returns at FIXED day-0 weights — the regime machine perceives
   *  the market, not the fund's own (de-risked) book. */
  benchmarkRets: number[];
  navSeries: number[] = [];
  private peakNav = -Infinity;
  private ewmaVarB: Record<BucketId, number>;
  private ewmaVarP: number;
  private day0Weights: Record<BucketId, number>;
  lastDrawdown = 0;
  lastVolRatio = 1;

  constructor(
    private scenario: ScenarioDef,
    warmup: Record<BucketId, number[]>,
    private seed: number,
    day0Weights: Record<BucketId, number>
  ) {
    this.day0Weights = day0Weights;
    this.rets = {} as Record<BucketId, number[]>;
    for (const b of BUCKETS) this.rets[b] = warmup[b].slice();
    this.ewmaVarB = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      const arr = this.rets[b];
      const m = arr.reduce((a, x) => a + x, 0) / arr.length;
      const v = arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1);
      this.ewmaVarB[b] = v;
    }
    // Warm-up portfolio returns at day-0 weights (leverage included).
    const pr: number[] = [];
    for (let d = 0; d < warmup['EQ'].length; d++) {
      let r = 0;
      for (const b of BUCKETS) r += day0Weights[b] * warmup[b][d];
      pr.push(r);
    }
    this.portfolioRets = pr;
    this.benchmarkRets = pr.slice(); // warm-up is already at day-0 weights
    const m = pr.reduce((a, x) => a + x, 0) / pr.length;
    this.ewmaVarP = pr.reduce((a, x) => a + (x - m) ** 2, 0) / (pr.length - 1);
  }

  /**
   * Called once per replay day. `portfolioRet` is the exact NAV return
   * (arithmetic identity from the ledger), so impact costs are priced into vol.
   */
  updateDay(bucketRets: Record<BucketId, number>, portfolioRet: number, nav: number) {
    for (const b of BUCKETS) {
      this.rets[b].push(bucketRets[b]);
      this.ewmaVarB[b] = EWMA_LAMBDA * this.ewmaVarB[b] + (1 - EWMA_LAMBDA) * bucketRets[b] ** 2;
    }
    this.portfolioRets.push(portfolioRet);
    let bench = 0;
    for (const b of BUCKETS) bench += this.day0Weights[b] * bucketRets[b];
    this.benchmarkRets.push(bench);
    this.ewmaVarP = EWMA_LAMBDA * this.ewmaVarP + (1 - EWMA_LAMBDA) * portfolioRet ** 2;
    this.navSeries.push(nav);
    this.peakNav = Math.max(this.peakNav, nav);
    this.lastDrawdown = this.navSeries.length ? nav / this.peakNav - 1 : 0;
    this.lastVolRatio = this.volRatio();
  }

  ewmaVol(b: BucketId): number {
    return Math.sqrt(this.ewmaVarB[b]);
  }

  /** Full bucket return history (warm-up + replay) — for momentum estimates. */
  bucketRets(b: BucketId): number[] {
    return this.rets[b];
  }

  /** n-day cumulative bucket return (momentum signal for the optimizer). */
  momentum(b: BucketId, n = 20): number {
    const arr = this.rets[b].slice(-n);
    return arr.reduce((a, x) => a + x, 0);
  }

  ewmaPortfolioVol(): number {
    return Math.sqrt(this.ewmaVarP);
  }

  /** Realized vol ratio 30d / 250d — on the day-0-weight BENCHMARK (market
   *  perception: the governor sees the world, not its own de-risked book). */
  volRatio(): number {
    const stdev = (arr: number[]) => {
      if (arr.length < 2) return 1e-4;
      const m = arr.reduce((a, x) => a + x, 0) / arr.length;
      return Math.sqrt(arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1));
    };
    const v30 = stdev(this.benchmarkRets.slice(-30));
    const v250 = stdev(this.benchmarkRets.slice(-250));
    return v250 > 1e-6 ? v30 / v250 : 1;
  }

  drawdown(): number {
    return this.lastDrawdown;
  }

  maxDrawdown(): number {
    let peak = -Infinity;
    let mdd = 0;
    for (const nav of this.navSeries) {
      peak = Math.max(peak, nav);
      mdd = Math.min(mdd, nav / peak - 1);
    }
    return mdd;
  }

  /**
   * Regime-conditioned Monte Carlo scenario matrix (N×6 daily returns) with a
   * Merton-flavoured jump overlay (4% of draws carry a 2–5σ jump in risk buckets).
   * Deterministic per (scenario, regime, day, seed) — the optimizer and the
   * metric see exactly the same scenarios, as the RU formulation requires.
   */
  scenarioMatrix(regime: Regime, day: number, n = 400): number[][] {
    const rng = streamRng(`cvar-${this.scenario.id}-${regime}-${day}`, this.seed);
    const M = CORR[regime].map((r) => r.slice());
    if (regime === 'CRISIS') {
      // COVID script override: EQ↔GSEC +0.10 (gilts sell in the dash-for-cash)
      M[0][1] = this.scenario.crisisEqGsecCorr;
      M[1][0] = this.scenario.crisisEqGsecCorr;
    }
    const L = cholesky(M);
    const out: number[][] = [];
    for (let s = 0; s < n; s++) {
      const u = Array.from({ length: 6 }, () => rng.normal());
      const z = L.map((row) => row.reduce((a, l, j) => a + l * u[j], 0));
      const rets = CORR_ORDER.map((b, i) => z[i] * VOL_TABLE[b][regime]);
      if (rng.uniform() < 0.04) {
        for (const i of [0, 2, 3, 4]) {
          rets[i] -= (2 + 3 * rng.uniform()) * VOL_TABLE[CORR_ORDER[i]][regime];
        }
      }
      out.push(rets);
    }
    return out;
  }

  /** Exact RU CVaR (fractional tail average) of a weight vector over scenarios. */
  cvar95(weights: Record<BucketId, number>, scenarios: number[][]): number {
    const n = scenarios.length;
    const tail = (1 - CVAR_ALPHA) * n;
    const losses = scenarios
      .map((rets) => -BUCKETS.reduce((a, b, i) => a + weights[b] * rets[i], 0))
      .sort((a, b) => b - a);
    const k = Math.floor(tail);
    let sum = 0;
    for (let i = 0; i < Math.min(k, n); i++) sum += losses[i];
    if (k < n) sum += (tail - k) * losses[k];
    return sum / tail;
  }

  cvarLimit(regime: Regime): number {
    return CONSTITUTION.A4_CVAR_LIMITS[regime];
  }

  /** FRTB-flavoured liquidity horizon at current ADV. */
  liquidity(
    values: Record<BucketId, number>,
    nav: number,
    advOf: (b: BucketId) => number,
    participationRate = CONSTITUTION.A3_PARTICIPATION_CAP
  ): LiquiditySnapshot {
    const perBucket = {} as Record<BucketId, number>;
    let weighted = 0;
    for (const b of BUCKETS) {
      const adv = advOf(b);
      const days = adv > 0 ? values[b] / (participationRate * adv) : 99;
      perBucket[b] = days;
      weighted += (values[b] / Math.max(nav, 1)) * days;
    }
    return { perBucket, portfolioDays: weighted };
  }

  /** Stress gate: shadow replay of the COVID-20 script on current weights. */
  stressGate(values: Record<BucketId, number>): StressResult {
    const v = { ...values };
    let total = v.EQ + v.GSEC + v.IGCORP + v.CRED + v.GOLD + v.LIQ;
    const initial = total;
    let peak = total;
    let mdd = 0;
    let worstDayLoss = 0;
    const scripted: Record<Exclude<BucketId, 'LIQ'>, number[]> = {
      EQ: scenarioScriptedRets(COVID20, 'EQ', 30),
      GSEC: scenarioScriptedRets(COVID20, 'GSEC', 30),
      IGCORP: scenarioScriptedRets(COVID20, 'IGCORP', 30),
      CRED: scenarioScriptedRets(COVID20, 'CRED', 30),
      GOLD: scenarioScriptedRets(COVID20, 'GOLD', 30),
    };
    for (let d = 0; d < 30; d++) {
      let dayLoss = 0;
      for (const b of ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD'] as const) {
        const r = scripted[b][d];
        dayLoss += -r * v[b];
        v[b] *= 1 + r;
      }
      total = v.EQ + v.GSEC + v.IGCORP + v.CRED + v.GOLD + v.LIQ;
      peak = Math.max(peak, total);
      mdd = Math.min(mdd, total / peak - 1);
      worstDayLoss = Math.max(worstDayLoss, dayLoss);
    }
    return {
      terminalDrawdown: mdd,
      worstDayLoss: worstDayLoss / Math.max(initial, 1),
      passesA4: worstDayLoss / Math.max(initial, 1) <= CONSTITUTION.A4_CVAR_LIMITS['CRISIS'] * 2,
      passesDdCap: mdd >= -0.12,
    };
  }
}
