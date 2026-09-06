/**
 * KAVACH — shared types.
 * Event-Aware Capital Governor for Indian Markets. All money is INR rupees (₹).
 */

export type BucketId = 'EQ' | 'GSEC' | 'IGCORP' | 'CRED' | 'GOLD' | 'LIQ';
export const BUCKETS: BucketId[] = ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD', 'LIQ'];
export const RISK_BUCKETS: BucketId[] = ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD'];

export type Regime = 'CALM' | 'STRESSED' | 'CRISIS' | 'RECOVERY';
export type Phase = Regime; // world-scripted phase (drives ADV + noise vol)

export type ScenarioId = 'TANTRUM-13' | 'ILFS-18' | 'COVID-20' | 'LIVE'; // 'LIVE' = live paper book (no scripted world)

export type AgentMode = 'naive' | 'governed' | 'world'; // 'world' = frozen book (calibration mode)

export type AutonomyLevel = 'FULL' | 'SUPERVISED' | 'CONSERVATIVE';

export type RadarProvider = 'dictionary' | 'llm' | 'llm-rejected' | 'gemini' | 'gemini-rejected';

export interface RadarEvent {
  day: number;
  headline: string;
  event: string;
  severity: number; // 1..5
  buckets: BucketId[];
  direction: 'risk_off' | 'risk_on' | 'neutral';
  confidence: number; // 0..1
  source: string;
  provider: RadarProvider;
  applied: boolean; // did it feed the regime machine (tighten-only, confidence >= 0.6)
  latencyMs?: number;
}

export interface BucketStat {
  bucket: BucketId;
  price: number;
  units: number;
  value: number; // ₹
  ret1d: number; // simple return vs yesterday close
  ewmaVol: number; // daily
}

export interface DayObservation {
  day: number;
  nav: number;
  gross: number;
  cash: number;
  borrowings: number;
  postedMtf: number;
  postedCcil: number;
  marginUtilization: number;
  prices: Record<BucketId, number>;
  values: Record<BucketId, number>;
  weights: Record<BucketId, number>; // value / gross
  regime: Regime;
  phase: Phase;
  advMult: number;
  drawdown: number; // negative, from running peak
  ewmaPortfolioVol: number; // daily
  volRatio: number; // 30d / 250d realized
  cvar95: number; // 1-day, fraction of NAV
  liquidityHorizonDays: number; // portfolio weighted
}

export interface TradeRecord {
  day: number;
  bucket: BucketId;
  value: number; // ₹ notional
  direction: 1 | -1; // buy / sell
  participation: number; // of current ADV
  tempCost: number; // ₹ paid
  permShift: number; // multiplicative dislocation applied
  reason: string;
}

export interface MarginEvent {
  day: number;
  channel: 'MTF' | 'CCIL';
  callAmount: number; // ₹ called
  paidFromCash: number;
  paidFromLiq: number;
  forcedSale: number; // ₹ raised by forced liquidation
  released: number; // ₹ released back
  requirement: number;
  posted: number;
}

export interface ConstitutionCheck {
  article: string;
  title: string;
  passed: boolean;
  detail: string;
  breached?: boolean;
}

export interface ApprovalCard {
  id: string;
  day: number;
  createdAtDay: number;
  deadlineDay: number;
  trade: {
    bucket: BucketId;
    value: number;
    direction: 1 | -1;
    participation: number;
  };
  regime: Regime;
  articlesInvoked: string[];
  counterfactual: {
    cvarIfRejected: number;
    liquidityHorizonIfRejected: number;
    forcedSaleRisk: 'LOW' | 'MEDIUM' | 'HIGH';
    note: string;
  };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT';
  decidedBy?: string;
}

export interface NarratorStats {
  scenario: ScenarioId;
  mode: AgentMode;
  navEnd: number;
  navStart: number;
  maxDrawdown: number;
  impactPaid: number;
  marginCumulative: number;
  forcedSaleEvents: number;
  maxParticipation: number;
  participationBreaches: number; // days any bucket > 10% ADV
  redemptionsMissed: number;
  articleViolations: string[];
  regimePath: Regime[];
}

export interface RecorderEntry {
  seq: number;
  day: number;
  kind: string;
  payload: Record<string, unknown>; // canonical, hashed
  prevHash: string;
  entryHash: string;
  meta?: { ts?: number; provider?: string; latencyMs?: number };
}
