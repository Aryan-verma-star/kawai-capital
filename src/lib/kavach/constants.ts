/**
 * KAVACH — world constants.
 * The book: ₹1,000 Cr NAV, ₹1,250 Cr gross, ₹250 Cr MTF borrowings (day-0 LTV 50%).
 * All ADV in ₹ Cr/day. Impact: Almgren-Chriss flavoured, κ=0.08 temp, γ=0.01 permanent,
 * permanent dislocation decays 0.90/day.
 */

import { BucketId, BUCKETS } from './types';

export { BUCKETS };
export type { BucketId };

export const SEED = 42;

export const CR = 1e7; // one crore, ₹
export const LAKH = 1e5;

export interface BucketDef {
  id: BucketId;
  name: string;
  proxy: string;
  startPrice: number;
  grossCr: number; // day-0 gross position, ₹ Cr
  calmAdvCr: number; // ₹ Cr/day at calm ADV
}

export const BOOK: BucketDef[] = [
  {
    id: 'EQ',
    name: 'Equity',
    proxy: 'NIFTY 50 index exposure',
    startPrice: 26000,
    grossCr: 500,
    calmAdvCr: 600,
  },
  {
    id: 'GSEC',
    name: 'G-Sec 10Y',
    proxy: '10Y benchmark G-Sec, 7.10% coupon 2034, mod. duration 6.8',
    startPrice: 100.0,
    grossCr: 250,
    calmAdvCr: 900,
  },
  {
    id: 'IGCORP',
    name: 'IG Corp',
    proxy: 'AAA/AA 5Y corporate basket, spread +55bp, duration ~4.3',
    startPrice: 100.0,
    grossCr: 200,
    calmAdvCr: 150,
  },
  {
    id: 'CRED',
    name: 'Credit',
    proxy: 'A-rated NBFC basket, spread +240bp, duration ~4.2',
    startPrice: 100.0,
    grossCr: 100,
    calmAdvCr: 40,
  },
  {
    id: 'GOLD',
    name: 'Gold (INR)',
    proxy: 'Gold, INR terms, ₹ per 10 grams',
    startPrice: 110000,
    grossCr: 100,
    calmAdvCr: 250,
  },
  {
    id: 'LIQ',
    name: 'Liquid',
    proxy: 'TREPS / overnight liquid, NAV ₹100',
    startPrice: 100.0,
    grossCr: 100,
    calmAdvCr: 5000,
  },
];

export const MTF_BORROWING_CR = 250; // ₹ Cr day-0 MTF borrowing
export const MTF_INTEREST_PA = 0.09; // 9% p.a., accrued daily on borrowings
export const LIQ_YIELD_PA = 0.065; // TREPS yield accrues in LIQ price

/** Daily vols (%) per bucket per regime. */
export const VOL_TABLE: Record<Exclude<BucketId, never>, Record<string, number>> = {
  EQ: { CALM: 0.008, STRESSED: 0.016, CRISIS: 0.032, RECOVERY: 0.014 },
  GSEC: { CALM: 0.0022, STRESSED: 0.0045, CRISIS: 0.009, RECOVERY: 0.004 },
  IGCORP: { CALM: 0.003, STRESSED: 0.007, CRISIS: 0.014, RECOVERY: 0.006 },
  CRED: { CALM: 0.0045, STRESSED: 0.012, CRISIS: 0.025, RECOVERY: 0.01 },
  GOLD: { CALM: 0.006, STRESSED: 0.011, CRISIS: 0.019, RECOVERY: 0.009 },
  LIQ: { CALM: 0.0001, STRESSED: 0.0002, CRISIS: 0.0004, RECOVERY: 0.00015 },
};

/** Correlation matrices per regime, order = [EQ, GSEC, IGCORP, CRED, GOLD, LIQ]. */
export const CORR_ORDER: BucketId[] = ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD', 'LIQ'];

function mat(rows: number[][]): number[][] {
  const n = rows.length;
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) m[i][j] = rows[i][j] ?? 0;
    for (let j = 0; j < i; j++) m[j][i] = m[i][j];
  }
  return m;
}

export const CORR: Record<string, number[][]> = {
  CALM: mat([
    [1.0],
    [-0.1, 1.0],
    [0.35, 0.25, 1.0],
    [0.4, 0.3, 0.45, 1.0],
    [-0.05, 0.05, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
  ]),
  STRESSED: mat([
    [1.0],
    [-0.05, 1.0],
    [0.55, 0.35, 1.0],
    [0.6, 0.45, 0.65, 1.0],
    [-0.1, 0.05, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
  ]),
  // Crisis: correlations tighten. EQ↔IGCORP 0.70, EQ↔CRED 0.75, IGCORP↔CRED 0.85,
  // EQ↔GOLD −0.20. Base crisis EQ↔GSEC 0.05; the COVID script overrides it to +0.10
  // (even gilts sell in the dash-for-cash).
  CRISIS: mat([
    [1.0],
    [0.05, 1.0],
    [0.7, 0.3, 1.0],
    [0.75, 0.4, 0.85, 1.0],
    [-0.2, 0.1, -0.1, -0.05, 1.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
  ]),
  RECOVERY: mat([
    [1.0],
    [-0.08, 1.0],
    [0.45, 0.28, 1.0],
    [0.5, 0.35, 0.55, 1.0],
    [-0.08, 0.05, 0.0, 0.0, 1.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
  ]),
};

/** COVID crisis override: EQ↔GSEC +0.10 (supply shock sells gilts too). */
export const COVID_CRISIS_CORR_OVERRIDE = 0.1;

/** Impact model (Almgren-Chriss flavoured). */
export const KAPPA = 0.08; // temporary impact coefficient
export const GAMMA = 0.01; // permanent impact coefficient
export const IMPACT_DECAY = 0.9; // permanent dislocation decays 0.90 / day
export const A3_PARTICIPATION_CAP = 0.1; // 10% of current ADV per bucket per day

/** Constitution (see governor/constitution.ts for enforcement). */
export const CONSTITUTION = {
  A1_LIQ_FLOOR: 0.05, // LIQ ≥ 5% NAV
  A2_BUCKET_CAP: 0.4, // max 40% in any single bucket
  A3_PARTICIPATION_CAP: 0.1, // trade size ≤ 10% current ADV
  A4_CVAR_LIMITS: { CALM: 0.025, STRESSED: 0.02, RECOVERY: 0.02, CRISIS: 0.015 },
  A5_MARGIN_COVER: 2.0, // LIQ ≥ 2× projected next-day margin
  A6_REDEMPTION_LOOKBACK: 3, // LIQ ≥ 3-day scripted redemption pace
  APPROVAL_THRESHOLD_NAV: 0.01, // SUPERVISED: trades > 1% NAV need approval
  APPROVAL_DEADLINE_DAYS: 2,
};

/** MTF margin: maintenance ratio path base (scenario scripts override). */
export const MTF_BASE_RATIO = 1.25;
export const CCIL_BASE_HAIRCUT = 0.025; // 2.5% calm clearing haircut

export const WARMUP_DAYS = 250; // estimator warm-up history (calm regime)
