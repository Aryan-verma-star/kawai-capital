/**
 * KAVACH — SimSession: one bot inside one scenario world.
 * Owns the engine, metrics, agent (naive / governed / world-frozen), and the
 * hash-chained flight recorder. The day cycle:
 *   open    → margin calls + releases (T-1 closes) + redemption taps
 *   radar   → headline → dictionary (+ async LLM overlay, tighten-only)
 *   agent   → optimizer proposal → constitution → consent → execution
 *   close   → price evolution (script + zero-sum noise + decaying impact)
 *   observe → metrics update + ledger recon + recorder entry
 */

import { BUCKETS, BucketId, CR, SEED } from './constants';
import { MetricsEngine } from './metrics/metrics';
import { FlightRecorder } from './recorder/flight';
import { NaiveBot } from './agents/naive';
import { GovernedBot } from './agents/governed';
import { warmupReturns, WorldEngine } from './world/engine';
import { SCENARIOS } from './world/scenarios';
import {
  AgentMode,
  ApprovalCard,
  AutonomyLevel,
  BucketStat,
  ConstitutionCheck,
  DayObservation,
  RadarEvent,
  Regime,
} from './types';
import { fmt_inr } from './format';

export interface SessionConfig {
  scenario: (typeof SCENARIOS)[keyof typeof SCENARIOS]['id'];
  mode: AgentMode;
  seed?: number;
  autonomy?: AutonomyLevel;
  llmRadar?: boolean;
  persistRecorder?: boolean;
  runTag?: string;
}

export interface BotSnapshot {
  mode: AgentMode;
  day: number;
  nav: number;
  drawdown: number;
  maxDrawdown: number;
  values: Record<BucketId, number>;
  weights: Record<BucketId, number>;
  prices: Record<BucketId, number>;
  cash: number;
  borrowings: number;
  postedMtf: number;
  postedCcil: number;
  liq: number;
  gross: number;
  bucketStats: BucketStat[];
  ewmaPortfolioVolAnn: number;
  volRatio: number;
  cvar95: number;
  cvarLimit: number;
  liquidityDays: number;
  liquidityPerBucket: Record<BucketId, number>;
  regime: Regime;
  regimePath: Regime[];
  navSeries: { day: number; nav: number; dd: number }[];
  marginCumulative: number;
  peakMarginCallDay: number;
  impactPaid: number;
  forcedSaleEvents: number;
  redemptionsMissed: number;
  maxParticipation: number;
  participationBreaches: number;
  cascadeDays: number;
  constitution: ConstitutionCheck[];
  approvals: ApprovalCard[];
  radarFeed: RadarEvent[];
  articleFired: { day: number; article: string; detail: string }[];
  ratchetEvents: { day: number; from: string; to: string; blocked: boolean }[];
}

export class SimSession {
  engine: WorldEngine;
  metrics: MetricsEngine;
  agent: NaiveBot | GovernedBot | null;
  recorder: FlightRecorder;
  day = 0;
  complete = false;
  observations: DayObservation[] = [];
  mode: AgentMode;
  scenarioId: string;
  private prevPrices: Record<BucketId, number>;
  private prevNav: number;
  private navStart: number;

  constructor(cfg: SessionConfig) {
    const scenario = SCENARIOS[cfg.scenario];
    const seed = cfg.seed ?? SEED;
    this.mode = cfg.mode;
    this.scenarioId = cfg.scenario;
    this.engine = new WorldEngine(scenario, seed, cfg.mode);
    const warmup = warmupReturns(scenario, seed);
    const nav0 = this.engine.nav();
    const w0: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) w0[b] = this.engine.bucketValue(b) / nav0;
    this.metrics = new MetricsEngine(scenario, warmup, seed, w0);
    this.metrics.navSeries.push(nav0);
    this.navStart = nav0;

    if (cfg.mode === 'naive') this.agent = new NaiveBot();
    else if (cfg.mode === 'governed') {
      const g = new GovernedBot();
      if (cfg.autonomy) g.autonomy.setLevel(cfg.autonomy, 0);
      g.llmEnabled = cfg.llmRadar ?? false;
      this.agent = g;
    } else this.agent = null;

    const runId = `${cfg.scenario}-${cfg.mode}-s${seed}${cfg.runTag ? '-' + cfg.runTag : ''}-${Math.floor(Date.now() / 1000)}`;
    this.recorder = new FlightRecorder(runId, cfg.persistRecorder ?? true);
    this.recorder.record(
      0,
      'SESSION_START',
      {
        scenario: cfg.scenario,
        mode: cfg.mode,
        seed,
        days: scenario.days,
        nav_day0: +(nav0 / CR).toFixed(6),
        gross_day0_cr: +(this.engine.gross() / CR).toFixed(4),
        borrowing_cr: +(this.engine.borrowings / CR).toFixed(2),
        posted_ccil_cr: +(this.engine.postedCcil / CR).toFixed(4),
      },
      { provider: 'kavach' }
    );
    this.prevPrices = { ...this.engine.prices };
    this.prevNav = nav0;
  }

  private record = (
    kind: string,
    payload: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): void => {
    this.recorder.record(this.day, kind, payload, meta);
  };

  get governed(): GovernedBot | null {
    return this.agent instanceof GovernedBot ? this.agent : null;
  }

  step(): DayObservation | null {
    if (this.complete) return null;
    const scenario = SCENARIOS[this.scenarioId as keyof typeof SCENARIOS];
    const d = this.day + 1;
    this.day = d; // entries recorded during this step carry the trading day (payload + entry agree)

    // ---- open: margin + redemptions (assessed on T-1 closes) ----
    const policy = this.mode === 'naive' ? 'naive' : this.mode === 'governed' ? 'governed' : 'world';
    const events = this.engine.stepOpen(d, policy);
    let scriptForced = false;
    for (const m of events.marginEvents) {
      if (m.callAmount > 0) {
        this.record('MARGIN_CALL', {
          day: d,
          channel: m.channel,
          call_cr: +(m.callAmount / CR).toFixed(4),
          paid_cash_cr: +(m.paidFromCash / CR).toFixed(4),
          paid_liq_cr: +(m.paidFromLiq / CR).toFixed(4),
          forced_sale_cr: +(m.forcedSale / CR).toFixed(4),
          requirement_cr: +(m.requirement / CR).toFixed(3),
          posted_after_cr: +(m.posted / CR).toFixed(3),
        });
        if (m.forcedSale > 0 || m.paidFromCash + m.paidFromLiq < m.callAmount - 1) scriptForced = true;
      } else if (m.released > 0) {
        this.record('MARGIN_RELEASE', {
          day: d,
          channel: m.channel,
          released_cr: +(m.released / CR).toFixed(4),
          posted_after_cr: +(m.posted / CR).toFixed(3),
        });
      }
    }
    for (const fs of events.forcedSales) {
      this.record('FORCED_SALE', {
        day: d,
        bucket: fs.bucket,
        value_cr: +(fs.value / CR).toFixed(3),
        participation: +fs.participation.toFixed(3),
        impact_cost_cr: +(fs.tempCost / CR).toFixed(4),
        reason: fs.reason,
      });
    }
    if (events.redemption) {
      this.record('REDEMPTION', {
        day: d,
        amount_cr: +(events.redemption.amount / CR).toFixed(3),
        paid_cr: +(events.redemption.paid / CR).toFixed(3),
        shortfall_cr: +(events.redemption.shortfall / CR).toFixed(3),
        forced_sale_cr: +(events.forcedSales.reduce((a, s) => a + s.value, 0) / CR).toFixed(3),
      });
      if (events.redemption.shortfall > 1 || events.forcedSales.length > 0) scriptForced = true;
      this.governed?.noteRedemption(d, events.redemption.amount);
    }

    // ---- radar: headline perception (governed only; tighten-only) ----
    const headline = scenario.headlines.find((h) => h.day === d);
    if (this.governed && headline) {
      this.governed.handleHeadline(d, headline.text, this.record);
    }

    // ---- approvals expiry (timeout ⇒ no trade, all recorded) ----
    this.governed?.markScriptForced(scriptForced);
    this.governed?.expireApprovals(this.engine, this.record);

    // ---- agent acts (trades at T-1 marks, through the impact model) ----
    if (this.agent) {
      this.agent.act(this.engine, this.metrics, d, this.record);
    }

    // ---- close: prices evolve (script + noise + decaying dislocation) ----
    this.engine.stepClose(d);

    // ---- metrics + observation ----
    const nav = this.engine.nav();
    const bucketRets: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) bucketRets[b] = this.engine.prices[b] / this.prevPrices[b] - 1;
    const portfolioRet = nav / this.prevNav - 1;
    this.metrics.updateDay(bucketRets, portfolioRet, nav);

    const values: Record<BucketId, number> = {} as Record<BucketId, number>;
    const weights: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      values[b] = this.engine.bucketValue(b);
      weights[b] = values[b] / Math.max(nav, 1);
    }
    const gross = BUCKETS.reduce((a, b) => a + values[b], 0);
    const g = this.governed;
    const regime: Regime = g ? g.regimeMachine.regime : 'CALM';
    const scen = this.metrics.scenarioMatrix(regime, d, 200);
    const cvar = this.metrics.cvar95(weights, scen);
    const liq = this.metrics.liquidity(values, nav, (b) => this.engine.adv(b, d));
    const obs: DayObservation = {
      day: d,
      nav,
      gross,
      cash: this.engine.cash,
      borrowings: this.engine.borrowings,
      postedMtf: this.engine.postedMtf,
      postedCcil: this.engine.postedCcil,
      marginUtilization: (this.engine.postedMtf + this.engine.postedCcil) / Math.max(nav, 1),
      prices: { ...this.engine.prices },
      values,
      weights,
      regime,
      phase: this.engine.phase(),
      advMult: scenario.advMultAt(Math.min(d, scenario.days)),
      drawdown: this.metrics.drawdown(),
      ewmaPortfolioVol: this.metrics.ewmaPortfolioVol(),
      volRatio: this.metrics.lastVolRatio,
      cvar95: cvar,
      liquidityHorizonDays: liq.portfolioDays,
    };
    this.observations.push(obs);

    // ---- ledger recon (must be an exact identity) ----
    const residual = this.engine.ledgerResidual();
    this.record('OBSERVATION', {
      day: d,
      nav_cr: +(nav / CR).toFixed(4),
      gross_cr: +(gross / CR).toFixed(3),
      cash_cr: +(this.engine.cash / CR).toFixed(4),
      borrowings_cr: +(this.engine.borrowings / CR).toFixed(3),
      posted_mtf_cr: +(this.engine.postedMtf / CR).toFixed(4),
      posted_ccil_cr: +(this.engine.postedCcil / CR).toFixed(4),
      ledger_residual: residual,
      regime,
      phase: obs.phase,
      drawdown: +obs.drawdown.toFixed(5),
      vol_ratio: +obs.volRatio.toFixed(3),
      cvar: +cvar.toFixed(5),
      liq_horizon_days: +liq.portfolioDays.toFixed(2),
      nav_str: fmt_inr(nav),
      prices: BUCKETS.map((b) => +this.engine.prices[b].toFixed(6)),
      values_cr: BUCKETS.map((b) => +(values[b] / CR).toFixed(3)),
    });

    this.prevPrices = { ...this.engine.prices };
    this.prevNav = nav;
    if (d >= scenario.days) {
      this.complete = true;
      this.recorder.record(d, 'SESSION_END', {
        nav_end_cr: +(nav / CR).toFixed(4),
        nav_total_ret: +(nav / this.navStart - 1).toFixed(5),
        max_drawdown: +this.metrics.maxDrawdown().toFixed(5),
        margin_cumulative_cr: +(this.engine.marginCumulative / CR).toFixed(4),
        impact_paid_cr: +(this.engine.impactPaid / CR).toFixed(4),
        recorder_entries: this.recorder.size(),
        head_hash: this.recorder.headHash(),
      });
    }
    return obs;
  }

  runToDay(target: number): void {
    while (!this.complete && this.day < target) this.step();
  }

  snapshot(): BotSnapshot {
    const nav = this.engine.nav();
    const values: Record<BucketId, number> = {} as Record<BucketId, number>;
    const weights: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      values[b] = this.engine.bucketValue(b);
      weights[b] = values[b] / Math.max(nav, 1);
    }
    const g = this.governed;
    const regime: Regime = g ? g.regimeMachine.regime : 'CALM';
    const liqSnap = this.metrics.liquidity(values, nav, (b) => this.engine.adv(b));
    const bucketStats: BucketStat[] = BUCKETS.map((b) => ({
      bucket: b,
      price: this.engine.prices[b],
      units: this.engine.units[b],
      value: values[b],
      ret1d: this.observations.length
        ? this.engine.prices[b] / this.prevPrices[b] - 1
        : 0,
      ewmaVol: this.metrics.ewmaVol(b),
    }));
    const navSeries = [{ day: 0, nav: this.navStart, dd: 0 }].concat(
      this.observations.map((o) => ({ day: o.day, nav: o.nav, dd: o.drawdown }))
    );
    return {
      mode: this.mode,
      day: this.day,
      nav,
      drawdown: this.metrics.drawdown(),
      maxDrawdown: this.metrics.maxDrawdown(),
      values,
      weights,
      prices: { ...this.engine.prices },
      cash: this.engine.cash,
      borrowings: this.engine.borrowings,
      postedMtf: this.engine.postedMtf,
      postedCcil: this.engine.postedCcil,
      liq: values['LIQ'],
      gross: BUCKETS.reduce((a, b) => a + values[b], 0),
      bucketStats,
      ewmaPortfolioVolAnn: this.metrics.ewmaPortfolioVol() * Math.sqrt(250),
      volRatio: this.metrics.lastVolRatio,
      cvar95: this.metrics.cvar95(weights, this.metrics.scenarioMatrix(regime, this.day, 200)),
      cvarLimit: this.metrics.cvarLimit(regime),
      liquidityDays: liqSnap.portfolioDays,
      liquidityPerBucket: liqSnap.perBucket,
      regime,
      regimePath: [{ day: 0, r: 'CALM' as Regime }, ...this.observations.map((o) => ({ day: o.day, r: o.regime }))].map((x) => x.r),
      navSeries,
      marginCumulative: this.engine.marginCumulative,
      peakMarginCallDay: this.engine.peakMarginCallDay,
      impactPaid: this.engine.impactPaid,
      forcedSaleEvents: this.engine.forcedSaleEvents,
      redemptionsMissed: this.engine.redemptionsMissed,
      maxParticipation: this.engine.maxParticipation,
      participationBreaches: this.engine.participationBreaches,
      cascadeDays: this.agent instanceof NaiveBot ? this.agent.cascadeDays : 0,
      constitution: g ? g.constitutionChecks : [],
      approvals: g ? g.consent.recent(30) : [],
      radarFeed: g ? g.radarFeed.slice(-30) : [],
      articleFired: g ? g.articleFired : [],
      ratchetEvents: g ? g.autonomy.ratchetEvents : [],
    };
  }
}
