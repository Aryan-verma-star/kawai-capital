/**
 * KAVACH — GovernedBot (M3/M4, the hero).
 *
 * Mean-risk optimizer (projected gradient over discrete CVaR scenarios,
 * Rockafellar-Uryasev formulation) whose every proposal passes the Governor
 * BEFORE execution: regime machine → optimizer proposes → constitution A1–A9
 * evaluates → consent (autonomy dial) → execution through the impact model
 * with A3 participation caps. Long-only. De-levering = selling risk AND
 * repaying MTF borrowings (gross exposure is Σ values; only repayment cuts it).
 */

import { BUCKETS, BucketId, CONSTITUTION, CR } from '../constants';
import { MetricsEngine } from '../metrics/metrics';
import { RadarEvent, Regime } from '../types';
import { WorldEngine } from '../world/engine';
import { RegimeMachine } from '../governor/regime';
import { AutonomyDial, ConsentQueue } from '../governor/consent';
import { blocksExecution, ConstitutionCheck, evaluateConstitution } from '../governor/constitution';
import { dictionaryRadar, llmRadar, RadarReading } from '../llm/radar';
import { capByParticipation } from '../world/execution';
import type { AdvisorProposal, ConstitutionClip } from '../llm/advisor';

export interface TradeIntent {
  bucket: BucketId;
  value: number;
  direction: 1 | -1;
  participation: number;
  /** 'ai_advisor' when an AI proposal survived the merge into the candidate set */
  origin?: 'optimizer' | 'ai_advisor' | 'optimizer+ai_advisor';
}

/** Regime gross-exposure caps (Σ sleeve values / NAV). Shared with the LIVE
 *  session state so the desk's risk-budget strip shows the same cap the
 *  optimizer actually uses. */
export const GROSS_CAP: Record<Regime, number> = {
  CALM: 1.25,
  STRESSED: 1.2,
  CRISIS: 1.1,
  RECOVERY: 1.15,
};

const LAMBDA: Record<Regime, number> = {
  CALM: 1.0,
  STRESSED: 2.0,
  CRISIS: 3.5,
  RECOVERY: 1.5,
};

/** Daily carry (annualized) — what the book earns for holding each sleeve. */
const CARRY: Record<BucketId, number> = {
  EQ: 0.09,
  GSEC: 0.071,
  IGCORP: 0.0765,
  CRED: 0.095,
  GOLD: 0.0,
  LIQ: 0.065,
};

/** AI decision-loop inputs, injected by the LIVE session BEFORE the sync
 *  rebalance runs (the calls are async; the decision loop is synchronous).
 *  REPLAY never sets this — the hash-chain determinism gate stays byte-identical. */
export interface AiDecisionInputs {
  advisor: {
    proposals: AdvisorProposal[];
    clips: ConstitutionClip[]; // parallel to proposals (post-constitution-clip)
    outcome: string;
    latencyMs: number;
  } | null;
}

/** What the Critic's verdict changes mechanically (only ADDS constraints). */
export interface CriticEscalation {
  all: boolean;
  buckets: BucketId[];
}

export interface RebalancePlan {
  day: number;
  regime: Regime;
  scenarios: number[][];
  target: { values: Record<BucketId, number>; gross: number; floorLiq: number };
  intents: TradeIntent[];
  aiMerges: { bucket: BucketId; proposalCr: number; optimizerCr: number; finalCr: number; origin: string }[];
  blocked: ConstitutionCheck[];
  projCvar: number;
  targetBorrow: number;
}

export class GovernedBot {
  readonly id = 'governed' as const;
  regimeMachine = new RegimeMachine();
  autonomy = new AutonomyDial('FULL');
  consent = new ConsentQueue();
  radarFeed: RadarEvent[] = [];
  articleFired: { day: number; article: string; detail: string }[] = [];
  llmEnabled = false; // set by ReplayController; determinism default off
  constitutionChecks: ConstitutionCheck[] = [];
  /** LIVE only: injected AI proposals (merged into the candidate set). */
  aiInputs: AiDecisionInputs | null = null;

  pendingTrades = new Map<string, TradeIntent>();
  private llmQueue: { day: number; headline: string; result: Promise<{ ok: boolean; reading?: RadarReading; reason?: string; latencyMs: number }> }[] = [];
  private lastScriptForced = false;
  private redemptionHistory: { day: number; amount: number }[] = [];

  // ---------------- radar ----------------

  /** Consume a scenario headline: dictionary first (deterministic), LLM overlay async. */
  handleHeadline(
    day: number,
    headline: string,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): void {
    this.processLlmQueue(record);
    const d = dictionaryRadar(headline);
    const applied = d.confidence >= 0.6 && (d.direction === 'risk_off' ? d.severity >= 3 : d.severity >= 4);
    this.radarFeed.push({
      day,
      headline,
      event: d.event,
      severity: d.severity,
      buckets: d.buckets,
      direction: d.direction,
      confidence: d.confidence,
      source: d.source,
      provider: 'dictionary',
      applied,
    });
    record(
      'RADAR',
      { day, headline, provider: 'dictionary', event: d.event, severity: d.severity, direction: d.direction, confidence: d.confidence, applied },
      { provider: 'dictionary' }
    );
    if (applied) this.regimeMachine.applyRadarSeverity(d.severity); // A7: tighten-only

    if (this.llmEnabled) {
      const result = llmRadar(headline);
      this.llmQueue.push({ day, headline, result });
    }
  }

  private processLlmQueue(
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): void {
    const q = this.llmQueue;
    this.llmQueue = [];
    for (const item of q) {
      void item.result.then((res) => {
        const provider = res.ok ? 'llm' : 'llm-rejected';
        const applied =
          res.ok && res.reading!.confidence >= 0.6 &&
          (res.reading!.direction === 'risk_off' ? res.reading!.severity >= 3 : res.reading!.severity >= 4);
        this.radarFeed.push({
          day: item.day,
          headline: item.headline,
          event: res.ok ? res.reading!.event : `rejected: ${res.reason}`,
          severity: res.ok ? res.reading!.severity : 0,
          buckets: res.ok ? res.reading!.buckets : [],
          direction: res.ok ? res.reading!.direction : 'neutral',
          confidence: res.ok ? res.reading!.confidence : 0,
          source: res.ok ? res.reading!.source : 'kavach-guardrail',
          provider,
          applied,
          latencyMs: res.latencyMs,
        });
        record(
          'RADAR',
          {
            day: item.day,
            headline: item.headline,
            provider,
            event: res.ok ? res.reading!.event : `rejected: ${res.reason}`,
            severity: res.ok ? res.reading!.severity : 0,
            direction: res.ok ? res.reading!.direction : 'neutral',
            confidence: res.ok ? res.reading!.confidence : 0,
            applied,
          },
          { provider, latencyMs: res.latencyMs }
        );
        if (applied) this.regimeMachine.applyRadarSeverity(res.reading!.severity);
      });
    }
  }

  markScriptForced(flag: boolean): void {
    this.lastScriptForced = flag;
  }

  noteRedemption(day: number, amount: number): void {
    this.redemptionHistory.push({ day, amount });
  }

  // ---------------- projections ----------------

  /** Conservative projected next-day cash outflow: margin calls + interest + redemptions. */
  projectedOutflow(engine: WorldEngine, regime: Regime): number {
    const buffer = regime === 'CRISIS' ? 1.2 : regime === 'STRESSED' ? 1.1 : 1.0;
    const eqVal = engine.bucketValue('EQ');
    const mtfCall = Math.max(0, engine.lastMtfRatio * buffer * engine.borrowings - (eqVal + engine.postedMtf));
    const ccilCall = Math.max(
      0,
      engine.lastCcilHaircut * buffer * (engine.bucketValue('GSEC') + engine.bucketValue('IGCORP')) - engine.postedCcil
        );
    const interest = (engine.borrowings * 0.09) / 250;
    const redemptionForecast = this.redemptionForecast(engine);
    return mtfCall + ccilCall + interest + redemptionForecast;
  }

  /** A6 pace: realized 3-day redemption run-rate + radar-forecast bump. */
  redemptionForecast(engine: WorldEngine): number {
    const recent = this.redemptionHistory.filter((r) => r.day > engine.day - 7);
    const realized = recent.reduce((a, r) => a + r.amount, 0) / 7 * 3; // 3-day pace
    const radarBump = this.radarFeed.some(
      (f) => f.day > engine.day - 8 && /redemption|outflow|gates? /i.test(f.headline)
    )
      ? 0.009 * engine.nav()
      : 0;
    return Math.max(realized, radarBump);
  }

  redemptionPace3d(engine: WorldEngine): number {
    return this.redemptionForecast(engine) / Math.max(engine.nav(), 1);
  }

  // ---------------- the act ----------------

  /** REPLAY path (and LIVE without AI): prepare → finalize in one synchronous pass. */
  act(
    engine: WorldEngine,
    metrics: MetricsEngine,
    day: number,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): void {
    const plan = this.prepareRebalance(engine, metrics, day, record);
    this.finalizeRebalance(engine, metrics, day, record, plan, null);
  }

  /**
   * Phase A of the decision loop: regime → optimizer → [AI advisor proposals
   * merged into the candidate set] → clipped intents → constitution A1–A9.
   * Returns the chosen plan; if `blocked` is non-empty the proposal is vetoed
   * (already recorded). LIVE inserts the async Critic call between this and
   * finalizeRebalance.
   */
  prepareRebalance(
    engine: WorldEngine,
    metrics: MetricsEngine,
    day: number,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): RebalancePlan {
    const nav = engine.nav();
    const emptyPlan: RebalancePlan = {
      day,
      regime: 'CALM',
      scenarios: [],
      target: { values: {} as Record<BucketId, number>, gross: 0, floorLiq: 0 },
      intents: [],
      aiMerges: [],
      blocked: [],
      projCvar: 0,
      targetBorrow: 0,
    };
    if (nav <= 0) return emptyPlan;

    // 1) regime update (hysteresis machine)
    const marginUtil = (engine.postedMtf + engine.postedCcil) / nav;
    const regime = this.regimeMachine.update(day, {
      volRatio: metrics.lastVolRatio,
      drawdown: metrics.drawdown(),
      radarSeverity: this.regimeMachine.radarPressure,
      marginUtilization: marginUtil,
    });
    if (regime === 'CRISIS') this.autonomy.armRatchet();
    for (const t of this.regimeMachine.transitions.splice(0)) {
      record('REGIME', { day, from: t.from, to: t.to, why: t.why });
    }

    // 2) optimize: target values per bucket
    const scenarios = metrics.scenarioMatrix(regime, day);
    const target = this.optimizeWeights(engine, metrics, regime, day, scenarios, record);

    // 3) build clipped trade intents
    const intents: TradeIntent[] = [];
    for (const b of BUCKETS) {
      if (b === 'LIQ') continue; // LIQ derives from cash flows
      const delta = target.values[b] - engine.bucketValue(b);
      if (Math.abs(delta) < 5e6) continue; // < ₹50 L ⇒ noise
      let value = Math.abs(delta);
      if (delta < 0) value = Math.min(value, engine.bucketValue(b));
      const adv = engine.adv(b);
      const clipped = capByParticipation(value, adv);
      if (clipped < 1e6) continue;
      intents.push({
        bucket: b,
        value: clipped,
        direction: delta > 0 ? 1 : -1,
        participation: clipped / adv,
        origin: 'optimizer',
      });
    }

    // 3b) LIVE: merge AI advisor proposals into the SAME candidate set —
    //     same A3 clips, same pipeline, tagged origin for the recorder.
    const aiMerges: RebalancePlan['aiMerges'] = [];
    if (this.aiInputs?.advisor) {
      const { proposals, clips } = this.aiInputs.advisor;
      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        const clip = clips[i];
        const aiValueCr = clip?.clippedToCr ?? 0;
        const aiValue = aiValueCr * CR;
        if (clip?.rejected || aiValue < 5e6) {
          record('AI_ADVISOR', {
            day,
            status: 'dropped',
            bucket: p.bucket,
            action: p.action,
            asked_cr: +p.amountCr.toFixed(2),
            rationale: p.rationale.slice(0, 200),
            reason: clip?.reason ?? 'below threshold',
            origin: 'ai_advisor',
          });
          continue;
        }
        const dir: 1 | -1 = p.action === 'buy' ? 1 : -1;
        const existing = intents.find((t) => t.bucket === p.bucket);
        let merged: TradeIntent;
        if (!existing) {
          const adv = engine.adv(p.bucket);
          const clipped = capByParticipation(aiValue, adv);
          if (clipped < 1e6) {
            record('AI_ADVISOR', {
              day, status: 'dropped', bucket: p.bucket, action: p.action,
              asked_cr: +aiValueCr.toFixed(2), rationale: p.rationale.slice(0, 200),
              reason: 'A3 clip leaves nothing viable', origin: 'ai_advisor',
            });
            continue;
          }
          merged = { bucket: p.bucket, value: clipped, direction: dir, participation: clipped / adv, origin: 'ai_advisor' };
          intents.push(merged);
        } else if (existing.direction === dir) {
          const adv = engine.adv(p.bucket);
          const combined = capByParticipation(existing.value + aiValue, adv);
          const finalCr = combined / CR;
          if (combined - existing.value < 1e6 && existing.value > 0) {
            record('AI_ADVISOR', {
              day, status: 'merged-capped', bucket: p.bucket, action: p.action,
              asked_cr: +aiValueCr.toFixed(2), rationale: p.rationale.slice(0, 200),
              reason: `optimizer already at A3 cap`, origin: 'ai_advisor',
            });
            aiMerges.push({ bucket: p.bucket, proposalCr: +aiValueCr.toFixed(2), optimizerCr: +(existing.value / CR).toFixed(2), finalCr: +finalCr.toFixed(2), origin: 'optimizer' });
            continue;
          }
          existing.value = combined;
          existing.participation = combined / adv;
          existing.origin = 'optimizer+ai_advisor';
          merged = existing;
        } else {
          // opposite directions: net them; the dominant source owns the origin
          const net = existing.value - aiValue;
          if (net >= 0) {
            existing.value = net;
            const adv = engine.adv(p.bucket);
            existing.participation = net / adv;
            merged = existing;
          } else {
            const adv = engine.adv(p.bucket);
            const clipped = capByParticipation(-net, adv);
            intents.splice(intents.indexOf(existing), 1);
            merged = { bucket: p.bucket, value: clipped, direction: dir, participation: clipped / adv, origin: 'ai_advisor' };
            if (clipped >= 1e6) intents.push(merged);
          }
        }
        record('AI_ADVISOR', {
          day,
          status: merged.value >= 1e6 ? 'merged' : 'dropped',
          bucket: p.bucket,
          action: p.action,
          asked_cr: +p.amountCr.toFixed(2),
          clipped_to_cr: +(merged.value / CR).toFixed(2),
          participation: +merged.participation.toFixed(3),
          rationale: p.rationale.slice(0, 200),
          clip_reason: clip?.reason,
          origin: 'ai_advisor',
        });
        aiMerges.push({
          bucket: p.bucket,
          proposalCr: +aiValueCr.toFixed(2),
          optimizerCr: 0,
          finalCr: +(merged.value / CR).toFixed(2),
          origin: merged.origin ?? 'optimizer',
        });
      }
    }
    const targetBorrow = Math.max(0, target.gross + engine.postedMtf + engine.postedCcil - nav);

    // 4) constitution evaluation on the projected post-trade state
    const preValues: Record<BucketId, number> = {} as Record<BucketId, number>;
    let preGross = 0;
    for (const b of BUCKETS) {
      preValues[b] = engine.bucketValue(b);
      preGross += Math.max(preValues[b], 0);
    }
    const preWeights: Record<BucketId, number> = {} as Record<BucketId, number>;
    let preMaxWeight = 0;
    for (const b of BUCKETS) {
      preWeights[b] = preValues[b] / nav;
      preMaxWeight = Math.max(preMaxWeight, Math.max(preValues[b], 0) / Math.max(preGross, 1));
    }
    const preCvar = metrics.cvar95(preWeights, scenarios);
    const projectedValues: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      let v = engine.bucketValue(b);
      for (const t of intents) if (t.bucket === b) v += t.direction * t.value;
      projectedValues[b] = Math.max(v, 0);
    }
    const projLiq = projectedValues['LIQ'];
    const projWeights: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) projWeights[b] = projectedValues[b] / nav;
    const projCvar = metrics.cvar95(projWeights, scenarios);
    const checks = evaluateConstitution({
      regime,
      nav,
      projectedValues,
      projectedLiq: projLiq,
      trades: intents,
      projectedMargin: this.projectedOutflow(engine, regime),
      redemptionPace3d: this.redemptionPace3d(engine),
      scriptForcedToday: this.lastScriptForced,
      cvar95: projCvar,
      preCvar95: preCvar,
      preMaxWeight,
      radarProvider: this.llmEnabled ? 'llm+dict' : 'dictionary',
      overrideRecorded: this.consent.all().some((c) => c.status !== 'PENDING'),
    });
    this.constitutionChecks = checks;
    record('CONSTITUTION', {
      day,
      regime,
      checks: checks.map((c) => ({ a: c.article, pass: c.passed, detail: c.detail })),
    });
    for (const c of checks) {
      if (!c.passed) {
        this.articleFired.push({ day, article: c.article, detail: c.detail });
      }
    }

    // 5) blocking articles → veto (A1 script-forced is flagged, not waived)
    const blocked = blocksExecution(checks);
    if (blocked.length > 0) {
      record('PROPOSAL', { day, status: 'BLOCKED', blocking: blocked.map((b) => b.article), intents: intents.map((t) => ({ bucket: t.bucket, value_cr: +(t.value / CR).toFixed(2), dir: t.direction })) });
      return { day, regime, scenarios, target, intents, aiMerges, blocked, projCvar, targetBorrow };
    }
    return { day, regime, scenarios, target, intents, aiMerges, blocked: [], projCvar, targetBorrow };
  }

  /**
   * Phase B: consent gate (with the Critic's escalation applied) → execution
   * → MTF repayment. `critic` is the live CriticEffect: it may only RAISE the
   * approval bar (flag → the flagged bucket's trades need consent even in
   * FULL autonomy; block_suggestion → the whole list does). null = REPLAY.
   */
  finalizeRebalance(
    engine: WorldEngine,
    metrics: MetricsEngine,
    day: number,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void,
    plan: RebalancePlan,
    critic: CriticEscalation | null
  ): void {
    const { intents, target, regime, scenarios, targetBorrow } = plan;
    const nav = engine.nav();
    if (nav <= 0) return;
    if (plan.blocked.length > 0) return; // veto already recorded in prepare
    record('PROPOSAL', {
      day,
      status: 'PROPOSED',
      regime,
      target_gross_cr: +(target.gross / CR).toFixed(1),
      cvar: +plan.projCvar.toFixed(5),
      intents: intents.map((t) => ({
        bucket: t.bucket,
        value_cr: +(t.value / CR).toFixed(2),
        dir: t.direction,
        participation: +t.participation.toFixed(3),
        origin: t.origin ?? 'optimizer',
      })),
      critic_escalation: critic ? { all: critic.all, buckets: critic.buckets } : null,
    });

    // 6) consent gate then execution
    const sells = intents.filter((t) => t.direction === -1);
    const buys = intents.filter((t) => t.direction === 1);
    const projLiq = this.projectedLiqAfter(engine, intents);
    for (const t of sells) this.executeIntent(engine, t, day, regime, metrics, scenarios, record, critic);
    // repay MTF toward target (de-lever) — but ONLY with cash beyond the LIQ
    // floor: the liquidity buffer (A1/A5/A6) is built FIRST, de-levering second.
    const liqTargetAbs = target.floorLiq * nav;
    const repayable = Math.max(0, engine.cash - Math.max(0, liqTargetAbs - engine.liqValue()));
    const repay = Math.min(Math.max(0, engine.borrowings - targetBorrow), repayable);
    if (repay > 1e6) {
      const paid = engine.repayBorrowing(repay);
      if (paid > 1e6) record('EXECUTION', { day, kind: 'repay_mtf', value_cr: +(paid / CR).toFixed(2), borrowings_cr: +(engine.borrowings / CR).toFixed(2) });
    }
    for (const t of buys) {
      if (engine.cash + Math.max(0, engine.bucketValue('LIQ') - projLiq) < t.value * 0.999) continue;
      this.executeIntent(engine, t, day, regime, metrics, scenarios, record, critic);
    }
  }

  /** Projected LIQ sleeve after the plan's intents (₹). */
  private projectedLiqAfter(engine: WorldEngine, intents: TradeIntent[]): number {
    let v = engine.bucketValue('LIQ');
    for (const t of intents) if (t.bucket === 'LIQ') v += t.direction * t.value;
    return v;
  }

  private executeIntent(
    engine: WorldEngine,
    t: TradeIntent,
    day: number,
    regime: Regime,
    metrics: MetricsEngine,
    scenarios: number[][],
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void,
    critic: CriticEscalation | null = null
  ): void {
    const needsConsent =
      this.consent.needsApproval(this.autonomy.level, t.value, engine.nav(), regime) ||
      (critic !== null && (critic.all || critic.buckets.includes(t.bucket)));
    if (!needsConsent) {
      const tr = engine.execute(
        t.bucket,
        t.value,
        t.direction,
        t.origin === 'ai_advisor' ? 'governed:ai-advisor' : 'governed:optimize'
      );
      if (tr) record('EXECUTION', { day, bucket: tr.bucket, dir: tr.direction, value_cr: +(tr.value / CR).toFixed(2), participation: +tr.participation.toFixed(3), impact_cost_cr: +(tr.tempCost / CR).toFixed(3), reason: tr.reason, origin: t.origin ?? 'optimizer' });
      return;
    }
    // consent card with counterfactual (Wachter et al. 2017);
    // a Critic escalation is stamped into the card's provenance
    const wNow: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) wNow[b] = engine.bucketValue(b) / engine.nav();
    const cvarIfRejected = metrics.cvar95(wNow, scenarios);
    const liq = metrics.liquidity(
      BUCKETS.reduce((o, b) => ((o[b] = engine.bucketValue(b)), o), {} as Record<BucketId, number>),
      engine.nav(),
      (b) => engine.adv(b)
    );
    const outflow = this.projectedOutflow(engine, regime);
    const cover = engine.bucketValue('LIQ') / Math.max(outflow, 1);
    const card = this.consent.create(
      day,
      { bucket: t.bucket, value: t.value, direction: t.direction, participation: t.participation },
      regime,
      critic !== null && (critic.all || critic.buckets.includes(t.bucket))
        ? ['A3', 'A4', 'CRITIC']
        : ['A3', 'A4'],
      {
        cvarIfRejected,
        liquidityHorizonIfRejected: liq.portfolioDays,
        forcedSaleRisk: cover < 2 ? 'HIGH' : cover < 3 ? 'MEDIUM' : 'LOW',
        note:
          t.direction === -1
            ? `If rejected, sleeve stays at risk through the stress path; projected 1-day CVaR ${(cvarIfRejected * 100).toFixed(2)}% NAV.`
            : `If rejected, the book stays underweight; recovery participation is delayed by A3 caps.`,
      }
    );
    this.pendingTrades.set(card.id, t);
    record(
      'APPROVAL_REQUEST',
      {
        day,
        id: card.id,
        bucket: t.bucket,
        dir: t.direction,
        value_cr: +(t.value / CR).toFixed(2),
        regime,
        deadline_day: card.deadlineDay,
        counterfactual: {
          cvar_if_rejected: +cvarIfRejected.toFixed(5),
          liq_horizon_days: +liq.portfolioDays.toFixed(2),
          forced_sale_risk: card.counterfactual.forcedSaleRisk,
        },
      },
      { provider: 'consent' }
    );
  }

  /** Human decision via the API; executes the stashed intent if approved in time. */
  decide(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    engine: WorldEngine,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): boolean {
    const card = this.consent.decide(id, decision);
    if (!card) return false;
    record('APPROVAL_DECISION', { day: engine.day, id, decision, by: card.decidedBy, bucket: card.trade.bucket, value_cr: +(card.trade.value / CR).toFixed(2) });
    if (decision === 'APPROVED') {
      const t = this.pendingTrades.get(id);
      this.pendingTrades.delete(id);
      if (t) {
        // A3 re-clip at execution time: ADV may have collapsed between proposal
        // and human decision — the constitution never sleeps, even on human
        // timing (A8 overrides risk appetite, never the hard limits).
        const adv = engine.adv(t.bucket);
        const clipped = capByParticipation(t.value, adv);
        const reClipped = clipped < t.value - 1;
        const tr = engine.execute(t.bucket, Math.max(clipped, 0), t.direction, `governed:human-approved`);
        if (tr)
          record('EXECUTION', {
            day: engine.day,
            bucket: tr.bucket,
            dir: tr.direction,
            value_cr: +(tr.value / CR).toFixed(2),
            participation: +tr.participation.toFixed(3),
            impact_cost_cr: +(tr.tempCost / CR).toFixed(3),
            reason: tr.reason,
            re_clipped_to_a3: reClipped,
          });
      }
    } else {
      this.pendingTrades.delete(id);
    }
    return true;
  }

  /** Called each step: expire stale approvals (timeout ⇒ no trade, all recorded). */
  expireApprovals(
    engine: WorldEngine,
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): void {
    const expired = this.consent.expirePast(engine.day);
    for (const c of expired) {
      this.pendingTrades.delete(c.id);
      record('APPROVAL_TIMEOUT', { day: engine.day, id: c.id, bucket: c.trade.bucket, value_cr: +(c.trade.value / CR).toFixed(2) });
    }
  }

  // ---------------- optimizer ----------------

  /**
   * Mean-risk utility: max μ·w − λ·CVaR95(w), long-only, projected onto
   * {w ≥ 0, w_b ≤ 40%, w_LIQ ≥ floor, 1 ≤ Σw ≤ grossCap} via water-filling
   * projection; CVaR evaluated exactly on the discrete scenario matrix (RU).
   * λ escalation until A4 passes; stress-gate failures tighten the gross cap.
   */
  optimizeWeights(
    engine: WorldEngine,
    metrics: MetricsEngine,
    regime: Regime,
    day: number,
    scenarios: number[][],
    record: (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>) => void
  ): { values: Record<BucketId, number>; gross: number; floorLiq: number } {
    const nav = engine.nav();
    const values: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) values[b] = engine.bucketValue(b);

    const stress = metrics.stressGate(values);
    let grossCap = GROSS_CAP[regime];
    if (!stress.passesDdCap) grossCap = Math.min(grossCap, 1.06);
    if (!stress.passesA4) grossCap = Math.min(grossCap, 1.1);

    const outflow = this.projectedOutflow(engine, regime);
    const floorLiq = Math.max(
      CONSTITUTION.A1_LIQ_FLOOR,
      (2 * outflow) / nav,
      this.redemptionPace3d(engine)
    );

    let lambda = LAMBDA[regime] * (1 + 0.15 * this.regimeMachine.radarPressure);
    const limit = metrics.cvarLimit(regime);
    let w: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) w[b] = values[b] / nav;

    const mu: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      const mom = metrics.momentum(b, 20);
      const momTilt = regime === 'CALM' || regime === 'RECOVERY' ? 0.02 : 0.05;
      mu[b] = CARRY[b] / 250 + Math.sign(mom) * momTilt * Math.min(Math.abs(mom), 0.05);
    }

    const project = (x: Record<BucketId, number>): Record<BucketId, number> => {
      const p = {} as Record<BucketId, number>;
      for (const b of BUCKETS) p[b] = Math.min(Math.max(x[b], 0), 1.5);
      p['LIQ'] = Math.max(p['LIQ'], Math.min(floorLiq, 0.6));
      let sum = BUCKETS.reduce((a, b) => a + p[b], 0);
      if (sum > grossCap) {
        const riskSum = sum - p['LIQ'];
        const room = Math.max(grossCap - p['LIQ'], 0);
        if (riskSum > 0) {
          const k = room / riskSum;
          if (k < 1) for (const b of BUCKETS) if (b !== 'LIQ') p[b] *= k;
        }
      }
      sum = BUCKETS.reduce((a, b) => a + p[b], 0);
      if (sum < 1 - 1e-9) p['LIQ'] += 1 - sum; // park surplus in the liquid sleeve
      // A2 on gross: trim any risk bucket above 40% of gross into LIQ
      for (let k = 0; k < 3; k++) {
        const s = Math.max(BUCKETS.reduce((a, b) => a + p[b], 0), 1e-9);
        let over = false;
        for (const b of BUCKETS) {
          if (b === 'LIQ') continue;
          const capW = CONSTITUTION.A2_BUCKET_CAP * s;
          if (p[b] > capW + 1e-9) {
            p['LIQ'] += p[b] - capW;
            p[b] = capW;
            over = true;
          }
        }
        if (!over) break;
      }
      return p;
    };

    let best = project({ ...w });
    for (let attempt = 0; attempt < 8; attempt++) {
      let cur = project({ ...w });
      for (let iter = 0; iter < 60; iter++) {
        // CVaR subgradient: worst (1−α) scenarios of −w·r
        const losses = scenarios
          .map((rets, s) => ({ s, loss: -BUCKETS.reduce((a, b, i) => a + cur[b] * rets[i], 0) }))
          .sort((a, b) => b.loss - a.loss);
        const tail = 0.05 * scenarios.length;
        const k = Math.floor(tail);
        const cvarGrad: Record<BucketId, number> = {} as Record<BucketId, number>;
        for (const b of BUCKETS) cvarGrad[b] = 0;
        const add = (s: number, wt: number) => {
          BUCKETS.forEach((b, i) => (cvarGrad[b] += (-wt * scenarios[s][i]) / tail));
        };
        for (let i = 0; i < Math.min(k, losses.length); i++) add(losses[i].s, 1);
        if (k < losses.length) add(losses[k].s, tail - k);
        for (const b of BUCKETS) {
          cur[b] += 0.02 * (mu[b] - lambda * cvarGrad[b]);
        }
        cur = project(cur);
      }
      best = cur;
      const cvar = metrics.cvar95(cur, scenarios);
      if (cvar <= limit + 1e-9) break;
      lambda *= 1.6;
      if (attempt === 3) grossCap = Math.max(1.0, grossCap - 0.05);
      if (attempt === 6) {
        // de-risk fallback: shift risk into LIQ until A4 passes
        for (let s = 0; s < 8 && metrics.cvar95(best, scenarios) > limit; s++) {
          for (const b of BUCKETS) {
            if (b === 'LIQ') continue;
            const move = Math.min(best[b] * 0.15, (CONSTITUTION.A2_BUCKET_CAP - best['LIQ']) );
            best[b] -= move;
            best['LIQ'] += move;
          }
          best = project(best);
        }
      }
    }
    const finalCvar = metrics.cvar95(best, scenarios);
    record('OPTIMIZER', {
      day,
      regime,
      lambda: +lambda.toFixed(2),
      cvar: +finalCvar.toFixed(5),
      limit,
      gross_cap: +grossCap.toFixed(3),
      floor_liq: +floorLiq.toFixed(4),
      stress_terminal_dd: +stress.terminalDrawdown.toFixed(4),
      weights: BUCKETS.map((b) => +(best[b]).toFixed(4)),
    });
    const out: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) out[b] = best[b] * nav;
    return { values: out, gross: BUCKETS.reduce((a, b) => a + best[b], 0) * nav, floorLiq };
  }
}
