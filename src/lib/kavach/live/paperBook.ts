/**
 * KAVACH — LIVE PAPER book (R5).
 *
 * The ₹1,000 Cr calibrated book (same units, same borrowings, same day-0
 * postings as REPLAY — the ledger identity is the same code) marked to:
 *  - EQ (^NSEI), GOLD (GC=F × USDINR): real Yahoo closes applied as
 *    RELATIVE moves on the calibrated start prices.
 *  - GSEC / IGCORP / CRED: MARK-TO-MODEL — no free Indian bond tickers
 *    exist; radar events drive yield/spread factors (duration-scaled price
 *    impact), decaying daily. Labeled honestly in the UI.
 *  - LIQ: TREPS-style accrual ~4% p.a. (LIVE convention).
 *
 * Margin channels stay live: MTF ratio + CCIL haircut start at calm levels
 * and are RAISED by severe radar events (tighten-only), decaying toward
 * base. ADV uses the calibrated constants with the regime multiplier —
 * the liquidity mirage is a market property, not a choice.
 *
 * Paper execution runs through the same Almgren-Chriss impact model and
 * A3 participation caps as REPLAY. Educational simulation — no real orders.
 */

import { BOOK, BUCKETS, BucketId, CCIL_BASE_HAIRCUT, MTF_BASE_RATIO, SEED } from '../constants';
import { WorldEngine, warmupReturns } from '../world/engine';
import { Anchor, ScenarioDef } from '../world/scenarios';
import { Phase, Regime } from '../types';
import { RealPrices } from './priceProvider';
import { RadarReading } from '../llm/radar';

export const LIVE_LIQ_YIELD_PA = 0.04; // TREPS-style accrual for the paper book
export const BOND_SLEEVES: BucketId[] = ['GSEC', 'IGCORP', 'CRED'];

/** Duration & per-event spread-widening (bp) of the mark-to-model bond factor. */
const BOND_MODEL: Record<string, { duration: number; bpPerSeverity: number }> = {
  GSEC: { duration: 6.8, bpPerSeverity: 3 },
  IGCORP: { duration: 4.3, bpPerSeverity: 7 },
  CRED: { duration: 4.2, bpPerSeverity: 16 },
};

const SPREAD_DECAY = 0.97; // stress factor decays 3%/day toward calm
const MARGIN_DECAY = 0.985; // margin tightness decays toward base

/**
 * Mutable LIVE scenario adapter: the WorldEngine consults the scenario for
 * margins/ADV; LIVE's values move with radar events and the regime instead
 * of a script. Everything else in the engine (ledger, execution, impact,
 * margin mechanics, forced-sale waterfall) is REUSED verbatim.
 */
export class LiveScenarioAdapter implements ScenarioDef {
  readonly id = 'LIVE' as const;
  readonly title = 'Live Paper Book';
  readonly story = 'The ₹1,000 Cr paper book marked to real market data and real headlines.';
  readonly days = 500;
  readonly anchors = {};
  readonly redemptions = [];
  readonly headlines = [];
  readonly crisisEqGsecCorr = 0.1;
  readonly fxPath: Anchor[] = [{ day: 0, ret: 88 }];
  readonly yieldPath: Anchor[] = [{ day: 0, ret: 7.1 }];

  advMult = 1.0;
  mtfRatio = MTF_BASE_RATIO;
  ccilHaircut = CCIL_BASE_HAIRCUT;

  phaseAt(): Phase {
    return 'CALM'; // noise vols unused in LIVE (marks are external)
  }
  advMultAt(): number {
    return this.advMult;
  }
  bucketAdvMult(): number {
    return 1;
  }
  marginAt(): { mtfRatio: number; ccilHaircut: number } {
    return { mtfRatio: this.mtfRatio, ccilHaircut: this.ccilHaircut };
  }
}

export interface BondMarkState {
  spreadFactor: Record<string, number>; // 1 = calm; <1 = stressed (price down)
}

export class PaperBook extends WorldEngine {
  readonly liveScenario: LiveScenarioAdapter;
  /** real prices at session anchor (first fetch) — relative moves apply from here */
  anchorReal: { eq: number; usdinr: number; goldUsd: number } | null = null;
  lastReal: { eq: number; usdinr: number; goldUsd: number; at: string } | null = null;
  spreadFactor: Record<string, number> = { GSEC: 1, IGCORP: 1, CRED: 1 };

  constructor(seed = SEED) {
    const adapter = new LiveScenarioAdapter();
    super(adapter, seed, 'governed');
    this.liveScenario = adapter;
  }

  /** Regime → ADV mirage multiplier (market property, not a choice). */
  setRegime(regime: Regime): void {
    this.liveScenario.advMult = regime === 'CRISIS' ? 0.25 : regime === 'STRESSED' ? 0.5 : regime === 'RECOVERY' ? 0.75 : 1.0;
  }

  /** Radar event → bond-spread factor move (mark-to-model; marks, not limits). */
  applyRadarMark(reading: RadarReading): { bucket: string; deltaPct: number }[] {
    const out: { bucket: string; deltaPct: number }[] = [];
    for (const b of BOND_SLEEVES) {
      if (!reading.buckets.includes(b)) continue;
      const model = BOND_MODEL[b];
      if (reading.direction === 'risk_off' && reading.severity >= 3) {
        const bp = model.bpPerSeverity * reading.severity;
        const hit = Math.max(0, 1 - model.duration * (bp / 10_000));
        this.spreadFactor[b] = Math.max(0.72, this.spreadFactor[b] * hit);
      } else if (reading.direction === 'risk_on' && reading.severity >= 2) {
        // recovery re-tightens spreads at a third of the stress rate
        this.spreadFactor[b] = Math.min(1, this.spreadFactor[b] + (1 - this.spreadFactor[b]) * 0.33);
      }
      out.push({ bucket: b, deltaPct: +(this.spreadFactor[b] * 100).toFixed(2) });
    }
    return out;
  }

  /** Radar severity → margin tightening (MTF ratio / CCIL haircut; raise-only). */
  applyRadarMargin(reading: RadarReading): void {
    if (reading.severity >= 3 && reading.direction === 'risk_off') {
      const step = reading.severity >= 4 ? 0.03 : 0.015;
      this.liveScenario.mtfRatio = Math.min(1.7, this.liveScenario.mtfRatio + step);
      this.liveScenario.ccilHaircut = Math.min(0.1, this.liveScenario.ccilHaircut + step / 6);
    }
  }

  /** Daily decay of spread stress + margin tightness toward calm. */
  decayModels(): void {
    for (const b of BOND_SLEEVES) {
      this.spreadFactor[b] = 1 + (this.spreadFactor[b] - 1) * SPREAD_DECAY;
    }
    const a = this.liveScenario;
    a.mtfRatio = MTF_BASE_RATIO + (a.mtfRatio - MTF_BASE_RATIO) * MARGIN_DECAY;
    a.ccilHaircut = CCIL_BASE_HAIRCUT + (a.ccilHaircut - CCIL_BASE_HAIRCUT) * MARGIN_DECAY;
  }

  /**
   * Re-mark the book to real prices. First call anchors the market; later
   * calls apply relative moves. Bond sleeves follow the model factor; LIQ
   * accrues 4% p.a. per market day. Impact dislocations persist on top.
   */
  markToReal(real: RealPrices): void {
    if (!this.anchorReal) {
      this.anchorReal = { eq: real.eq, usdinr: real.usdinr, goldUsd: real.goldUsd };
    }
    this.lastReal = { eq: real.eq, usdinr: real.usdinr, goldUsd: real.goldUsd, at: real.asOf };
    const a = this.anchorReal;
    const eqR = real.eq / a.eq;
    const goldR = (real.goldUsd * real.usdinr) / (a.goldUsd * a.usdinr);
    const start = (b: BucketId) => BOOK.find((x) => x.id === b)!.startPrice;
    this.clean['EQ'] = start('EQ') * eqR;
    this.clean['GOLD'] = start('GOLD') * goldR;
    for (const b of BOND_SLEEVES) this.clean[b] = start(b) * this.spreadFactor[b];
    this.clean['LIQ'] = start('LIQ') * Math.pow(1 + LIVE_LIQ_YIELD_PA / 250, this.day);
    for (const b of BUCKETS) this.prices[b] = this.clean[b] * this.disloc[b];
  }

  /** Day close: decay impact dislocations + model stress, sweep cash to LIQ. */
  closeLiveDay(): void {
    for (const b of BUCKETS) {
      if (b === 'LIQ') continue;
      this.disloc[b] = 1 + (this.disloc[b] - 1) * 0.9;
      this.prices[b] = this.clean[b] * this.disloc[b];
    }
    this.decayModels();
    this.sweepCashToLiq();
  }

  /** Warm-up history for the metrics engine (calm-regime, seeded, LIVE id). */
  static warmup(seed = SEED): Record<BucketId, number[]> {
    const adapter = new LiveScenarioAdapter();
    return warmupReturns(adapter, seed);
  }
}
