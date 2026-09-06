/**
 * KAVACH — scenario scripts (deterministic overlays on the seeded engine).
 *
 * Each scenario defines cumulative-return anchors per bucket (the "scripted days"),
 * the world phase path (drives ADV + noise vols), the margin script (MTF ratio hikes
 * and CCIL haircut hikes — assessed on T-1 closes, called at T open), redemption taps,
 * and synthetic Indian headlines consumed by the Event Radar.
 *
 * Historical anchors:
 *  - TANTRUM-13: May–Sept 2013 taper panic (INR −13%, G-Sec +150bp, gold rallied in INR).
 *  - ILFS-18:    Sept 2018 IL&FS default (₹91,000 Cr group debt), NBFC funding freeze,
 *                cascading debt-fund redemptions.
 *  - COVID-20:   March 2020 dash-for-cash; gold sold to meet margins; RBI repo cut
 *                115bp + LTRO/OMO on day 14.
 */

import { BucketId, Phase, ScenarioId } from '../types';

/** The three scripted crises (REPLAY). 'LIVE' is the live paper pseudo-scenario. */
export type CrisisId = Exclude<ScenarioId, 'LIVE'>;

export interface Anchor {
  day: number;
  ret: number; // cumulative return from day 0
}

export interface MarginStep {
  day: number;
  mtfRatio?: number;
  ccilHaircut?: number;
}

export interface RedemptionTap {
  day: number;
  pctOfAum: number;
}

export interface Headline {
  day: number;
  text: string;
}

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  story: string;
  days: number;
  anchors: Partial<Record<Exclude<BucketId, 'LIQ'>, Anchor[]>>;
  phaseAt(day: number): Phase;
  advMultAt(day: number): number;
  bucketAdvMult(bucket: BucketId, day: number): number;
  marginAt(day: number): { mtfRatio: number; ccilHaircut: number };
  redemptions: RedemptionTap[];
  headlines: Headline[];
  crisisEqGsecCorr: number; // COVID override: +0.10 (gilts sell in dash-for-cash)
  fxPath: Anchor[]; // USD/INR
  yieldPath: Anchor[]; // 10Y G-Sec yield %
}

function stepPath(steps: { day: number; value: number }[], day: number): number {
  if (day <= steps[0].day) return steps[0].value;
  for (let i = 1; i < steps.length; i++) {
    if (day <= steps[i].day) {
      const a = steps[i - 1];
      const b = steps[i];
      const t = (day - a.day) / (b.day - a.day);
      return a.value + t * (b.value - a.value);
    }
  }
  return steps[steps.length - 1].value;
}

function phaseFromSegments(segs: [number, Phase][], day: number): Phase {
  let cur = segs[0][1];
  for (const [d, p] of segs) if (day >= d) cur = p;
  return cur;
}

const ADV_BY_PHASE: Record<Phase, number> = {
  CALM: 1.0,
  STRESSED: 0.5,
  CRISIS: 0.25,
  RECOVERY: 0.75,
};

/** Cumulative scripted return at end of `day` (anchor interpolation). */
function cumAt(anchors: Anchor[], day: number): number {
  if (anchors.length === 0 || day <= 0) return 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i];
    if (day < a.day) {
      const p = anchors[i - 1];
      const t = (day - p.day) / (a.day - p.day);
      return p.ret + t * (a.ret - p.ret);
    }
    if (day === a.day) return a.ret;
  }
  return anchors[anchors.length - 1].ret;
}

/** Geometric daily scripted return ON day d (>0). */
export function scriptedDailyRets(anchors: Anchor[], day: number): number {
  if (anchors.length === 0 || day <= 0) return 0;
  return (1 + cumAt(anchors, day)) / (1 + cumAt(anchors, day - 1)) - 1;
}

export const TANTRUM13: ScenarioDef = {
  id: 'TANTRUM-13',
  title: 'Taper Tantrum 2013',
  story:
    'May–Sept 2013: the Fed signals taper; FPIs pull out of India, the rupee plunges to a lifetime low, and gilts sell off hard. Gold in INR rallies as the currency falls.',
  days: 30,
  anchors: {
    EQ: [
      { day: 0, ret: 0 },
      { day: 3, ret: -0.02 },
      { day: 8, ret: -0.045 },
      { day: 12, ret: -0.065 },
      { day: 18, ret: -0.085 }, // trough
      { day: 24, ret: -0.07 },
      { day: 30, ret: -0.06 },
    ],
    GSEC: [
      { day: 0, ret: 0 },
      { day: 5, ret: -0.029 }, // +40bp
      { day: 10, ret: -0.061 }, // +90bp
      { day: 15, ret: -0.0884 }, // +130bp trough (130bp × 6.8 duration)
      { day: 22, ret: -0.078 },
      { day: 30, ret: -0.068 }, // −30bp partial recovery
    ],
    IGCORP: [
      { day: 0, ret: 0 },
      { day: 8, ret: -0.015 },
      { day: 15, ret: -0.038 },
      { day: 22, ret: -0.044 },
      { day: 30, ret: -0.04 },
    ],
    CRED: [
      { day: 0, ret: 0 },
      { day: 8, ret: -0.02 },
      { day: 15, ret: -0.052 },
      { day: 22, ret: -0.063 }, // spread peak ~+150bp × 4.2
      { day: 30, ret: -0.06 },
    ],
    GOLD: [
      { day: 0, ret: 0 },
      { day: 5, ret: 0.035 },
      { day: 10, ret: 0.06 },
      { day: 18, ret: 0.098 }, // peak (rupee trough)
      { day: 24, ret: 0.096 },
      { day: 30, ret: 0.095 }, // +9.5% — INR depreciation makes gold rally
    ],
  },
  phaseAt: (d) =>
    phaseFromSegments(
      [
        [0, 'CALM'],
        [3, 'STRESSED'],
        [10, 'CRISIS'],
        [21, 'STRESSED'],
        [25, 'RECOVERY'],
      ],
      d
    ),
  advMultAt: (d) => ADV_BY_PHASE[phaseFromSegments(
    [
      [0, 'CALM'],
      [3, 'STRESSED'],
      [10, 'CRISIS'],
      [21, 'STRESSED'],
      [25, 'RECOVERY'],
    ],
    d
  )],
  bucketAdvMult: () => 1.0,
  marginAt: (d) => ({
    mtfRatio: stepPath(
      [
        { day: 0, value: 1.25 },
        { day: 10, value: 1.3 },
        { day: 18, value: 1.28 },
        { day: 26, value: 1.25 },
      ],
      d
    ),
    ccilHaircut: stepPath(
      [
        { day: 0, value: 0.025 },
        { day: 8, value: 0.0335 },
        { day: 15, value: 0.0375 },
        { day: 24, value: 0.031 },
        { day: 28, value: 0.025 },
      ],
      d
    ),
  }),
  redemptions: [],
  headlines: [
    { day: 1, text: 'US Fed signals taper of bond purchases; global bond yields spike' },
    { day: 4, text: 'FPIs sell ₹2,800 Cr in Indian equities; rupee hits lifetime low' },
    { day: 10, text: 'Rupee slides past 92/USD as CAD widens; RBI intervenes in FX market' },
    { day: 15, text: '10Y G-Sec yield tops 8.40% after 130bp sell-off; FPI debt outflows accelerate' },
    { day: 21, text: 'RBI announces special OMOs; government moves to calm taper fears' },
    { day: 26, text: 'Rupee recovers off trough as FPI selling ebbs; gold holds INR gains' },
  ],
  crisisEqGsecCorr: 0.05,
  fxPath: [
    { day: 0, ret: 88.0 },
    { day: 18, ret: 96.4 },
    { day: 30, ret: 94.0 },
  ],
  yieldPath: [
    { day: 0, ret: 7.1 },
    { day: 15, ret: 8.4 },
    { day: 22, ret: 8.25 },
    { day: 30, ret: 8.1 },
  ],
};

export const ILFS18: ScenarioDef = {
  id: 'ILFS-18',
  title: 'IL&FS Credit Freeze 2018',
  story:
    'Sept 2018: an infrastructure conglomerate defaults; NBFC funding freezes; debt funds face cascading redemptions — the Franklin Templeton preview. Credit paper becomes unsellable exactly when you need to sell it.',
  days: 45,
  anchors: {
    EQ: [
      { day: 0, ret: 0 },
      { day: 3, ret: -0.02 },
      { day: 10, ret: -0.06 },
      { day: 20, ret: -0.09 }, // trough
      { day: 30, ret: -0.07 },
      { day: 45, ret: -0.05 },
    ],
    GSEC: [
      { day: 0, ret: 0 },
      { day: 5, ret: 0.006 }, // flight to quality + RBI OMOs
      { day: 15, ret: 0.016 },
      { day: 25, ret: 0.021 },
      { day: 35, ret: 0.019 },
      { day: 45, ret: 0.02 },
    ],
    IGCORP: [
      { day: 0, ret: 0 },
      { day: 1, ret: -0.012 },
      { day: 10, ret: -0.035 },
      { day: 25, ret: -0.056 }, // +130bp spread peak
      { day: 38, ret: -0.052 },
      { day: 45, ret: -0.05 },
    ],
    CRED: [
      { day: 0, ret: 0 },
      { day: 1, ret: -0.025 }, // default event
      { day: 5, ret: -0.08 },
      { day: 10, ret: -0.12 },
      { day: 18, ret: -0.165 },
      { day: 25, ret: -0.175 }, // trough: +420bp × 4.2 duration
      { day: 32, ret: -0.168 },
      { day: 38, ret: -0.158 },
      { day: 45, ret: -0.15 },
    ],
    GOLD: [
      { day: 0, ret: 0 },
      { day: 20, ret: 0.015 },
      { day: 45, ret: 0.02 },
    ],
  },
  phaseAt: (d) =>
    phaseFromSegments(
      [
        [0, 'CALM'],
        [1, 'STRESSED'],
        [10, 'CRISIS'],
        [29, 'STRESSED'],
        [37, 'RECOVERY'],
      ],
      d
    ),
  advMultAt: (d) => ADV_BY_PHASE[phaseFromSegments(
    [
      [0, 'CALM'],
      [1, 'STRESSED'],
      [10, 'CRISIS'],
      [29, 'STRESSED'],
      [37, 'RECOVERY'],
    ],
    d
  )],
  // NBFC paper becomes unsellable: CRED ADV collapses far beyond the market-wide phase
  // multiplier — the liquidity mirage made flesh.
  bucketAdvMult: (bucket, day) => {
    const inFreeze = day >= 8 && day <= 30;
    if (bucket === 'CRED' && inFreeze) return 0.5;
    if (bucket === 'IGCORP' && inFreeze) return 0.7;
    if (bucket === 'EQ' && day >= 10 && day <= 25) return 0.85;
    return 1.0;
  },
  marginAt: (d) => ({
    mtfRatio: stepPath(
      [
        { day: 0, value: 1.25 },
        { day: 12, value: 1.3 },
        { day: 30, value: 1.28 },
        { day: 40, value: 1.25 },
      ],
      d
    ),
    ccilHaircut: stepPath(
      [
        { day: 0, value: 0.025 },
        { day: 10, value: 0.028 },
        { day: 20, value: 0.03 },
        { day: 35, value: 0.027 },
        { day: 42, value: 0.025 },
      ],
      d
    ),
  }),
  // The Franklin preview: −3% of AUM on each tap day (≈18% cumulative).
  redemptions: [8, 14, 20, 26, 32, 38].map((day) => ({ day, pctOfAum: 0.03 })),
  headlines: [
    { day: 1, text: 'IL&FS defaults on commercial paper; ₹91,000 Cr group debt under cloud' },
    { day: 6, text: 'NBFC commercial paper market freezes; short-term funding gaps out' },
    { day: 12, text: 'Default fears trigger redemption rush in credit-risk mutual funds' },
    { day: 20, text: 'Mutual funds dump NBFC paper to meet redemptions; spreads at multi-year highs' },
    { day: 26, text: 'RBI steps up OMO purchases to soothe NBFC funding stress' },
    { day: 32, text: 'Redemption pressure persists; more funds gate credit schemes' },
    { day: 40, text: 'Spreads normalize off peaks; credit markets stabilize' },
  ],
  crisisEqGsecCorr: 0.05,
  fxPath: [
    { day: 0, ret: 72.5 },
    { day: 20, ret: 74.2 },
    { day: 45, ret: 73.5 },
  ],
  yieldPath: [
    { day: 0, ret: 8.0 },
    { day: 25, ret: 7.68 },
    { day: 45, ret: 7.7 },
  ],
};

export const COVID20: ScenarioDef = {
  id: 'COVID-20',
  title: 'COVID Dash-for-Cash 2020',
  story:
    'March 2020: global margin spiral; even gold is sold to meet margins; gilts hit by a supply shock. Then RBI rides in — repo cut 115bp plus LTRO/OMO — and recovery begins.',
  days: 30,
  anchors: {
    EQ: [
      { day: 0, ret: 0 },
      { day: 3, ret: -0.04 },
      { day: 6, ret: -0.085 },
      { day: 10, ret: -0.16 },
      { day: 12, ret: -0.18 }, // trough
      { day: 14, ret: -0.165 },
      { day: 18, ret: -0.13 },
      { day: 22, ret: -0.105 },
      { day: 26, ret: -0.09 },
      { day: 30, ret: -0.0816 }, // +12% from trough → ≈ −8.2%
    ],
    GSEC: [
      { day: 0, ret: 0 },
      { day: 5, ret: -0.01 },
      { day: 10, ret: -0.025 }, // supply shock; gilts sell too
      { day: 12, ret: -0.022 },
      { day: 14, ret: -0.01 }, // RBI day
      { day: 18, ret: 0.005 },
      { day: 22, ret: 0.013 },
      { day: 26, ret: 0.018 },
      { day: 30, ret: 0.02 },
    ],
    IGCORP: [
      { day: 0, ret: 0 },
      { day: 10, ret: -0.06 },
      { day: 14, ret: -0.07 }, // trough
      { day: 20, ret: -0.055 },
      { day: 26, ret: -0.035 },
      { day: 30, ret: -0.02 },
    ],
    CRED: [
      { day: 0, ret: 0 },
      { day: 10, ret: -0.08 },
      { day: 14, ret: -0.095 }, // spread peak
      { day: 20, ret: -0.08 },
      { day: 26, ret: -0.06 },
      { day: 30, ret: -0.05 },
    ],
    GOLD: [
      { day: 0, ret: 0 },
      { day: 3, ret: -0.015 },
      { day: 6, ret: -0.03 },
      { day: 10, ret: -0.05 }, // sold for margins — authentic March 2020
      { day: 14, ret: -0.04 },
      { day: 18, ret: -0.01 },
      { day: 22, ret: 0.02 },
      { day: 26, ret: 0.05 },
      { day: 30, ret: 0.083 }, // +14% from trough → ≈ +8.3%
    ],
  },
  phaseAt: (d) =>
    phaseFromSegments(
      [
        [0, 'CALM'],
        [2, 'STRESSED'],
        [10, 'CRISIS'],
        [20, 'STRESSED'],
        [28, 'RECOVERY'],
      ],
      d
    ),
  // Spec: ADV multiplier path 1.00 (days 0–4) → 0.50 (5–9) → 0.25 (10–19) → 0.50 (20–27) → 1.00 (28+)
  advMultAt: (d) => (d <= 4 ? 1.0 : d <= 9 ? 0.5 : d <= 19 ? 0.25 : d <= 27 ? 0.5 : 1.0),
  bucketAdvMult: (bucket, day) => {
    if (bucket === 'IGCORP' && day >= 10 && day <= 19) return 0.8;
    if (bucket === 'CRED' && day >= 10 && day <= 19) return 0.8;
    return 1.0;
  },
  marginAt: (d) => ({
    mtfRatio: stepPath(
      [
        { day: 0, value: 1.25 },
        { day: 6, value: 1.4 },
        { day: 9, value: 1.55 },
        { day: 12, value: 1.65 },
        { day: 20, value: 1.45 },
        { day: 26, value: 1.25 },
      ],
      d
    ),
    ccilHaircut: stepPath(
      [
        { day: 0, value: 0.025 },
        { day: 4, value: 0.033 },
        { day: 8, value: 0.0435 },
        { day: 11, value: 0.0565 },
        { day: 13, value: 0.059 },
        { day: 20, value: 0.045 },
        { day: 26, value: 0.03 },
        { day: 28, value: 0.025 },
      ],
      d
    ),
  }),
  redemptions: [],
  headlines: [
    { day: 1, text: 'COVID-19 declared a pandemic; global markets crash' },
    { day: 5, text: 'FPIs sell ₹6,100 Cr in Indian equities in a single session; VIX at decade high' },
    { day: 8, text: 'Margin calls spike as global volatility soars; funds scramble for cash' },
    { day: 12, text: 'Dash for cash: even gold is sold to meet margin calls; gilts hit by supply shock' },
    { day: 14, text: 'RBI cuts repo 115bp, announces LTRO and OMO; nationwide lockdown begins' },
    { day: 20, text: 'Global central bank liquidity flows; Indian markets stabilize off lows' },
    { day: 28, text: 'Markets consolidate as liquidity normalizes; recovery underway' },
  ],
  crisisEqGsecCorr: 0.1,
  fxPath: [
    { day: 0, ret: 71.0 },
    { day: 12, ret: 75.8 },
    { day: 20, ret: 76.2 },
    { day: 30, ret: 74.9 },
  ],
  yieldPath: [
    { day: 0, ret: 6.35 },
    { day: 10, ret: 6.72 },
    { day: 14, ret: 5.95 },
    { day: 30, ret: 6.05 },
  ],
};

export const SCENARIOS: Record<CrisisId, ScenarioDef> = {
  'TANTRUM-13': TANTRUM13,
  'ILFS-18': ILFS18,
  'COVID-20': COVID20,
};

/** Pure scripted daily returns for a bucket (no noise, no impact) — used by the stress gate. */
export function scenarioScriptedRets(
  scenario: ScenarioDef,
  bucket: Exclude<BucketId, 'LIQ'>,
  days: number
): number[] {
  const anchors = scenario.anchors[bucket] ?? [];
  const out: number[] = [];
  for (let d = 1; d <= days; d++) out.push(scriptedDailyRets(anchors, d));
  return out;
}
