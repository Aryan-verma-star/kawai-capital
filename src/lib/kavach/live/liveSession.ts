/**
 * KAVACH — LIVE PAPER session (R5).
 *
 * One ₹1,000 Cr paper book, one governor, one recorder — same code as
 * REPLAY, different data source: real Yahoo marks for EQ/GOLD, mark-to-model
 * for the bond sleeves, real news perceived by Gemini (dictionary fallback),
 * AI voices (Advisor + Critic) inside the decision loop with zero authority.
 *
 * The decision pipeline, in order (README diagram):
 *   news → Radar → regime (tighten-only) → [optimizer + Advisor proposals]
 *   → constitution A1–A9 → Critic challenge → autonomy dial / consent cards
 *   → execute via impact model → recorder entry.
 *
 * Market-hours gate: Mon–Fri 09:15–15:30 IST minus an approximate holiday
 * list. Outside hours: "MARKET CLOSED — prices as of last close", no
 * rebalance fires (force is a test-only escape hatch, recorded when used).
 *
 * Persistence: sessions + daily book snapshots + the durable approval queue
 * in SQLite; evidence in the hash-chained recorder (chain RESUMES across
 * restarts — seq + prevHash continue, never reset).
 *
 * Educational paper simulation. It never places real orders.
 */

import { BUCKETS, BucketId, CR, SEED } from '../constants';
import { MetricsEngine } from '../metrics/metrics';
import { FlightRecorder } from '../recorder/flight';
import { GovernedBot, TradeIntent, CriticEscalation, GROSS_CAP } from '../agents/governed';
import { AutonomyLevel, ApprovalCard, RadarEvent, Regime } from '../types';
import { PaperBook } from './paperBook';
import { fetchRealPrices, priceStatus, RealPrices } from './priceProvider';
import { marketStatus, MarketStatus, istDateStringOf } from './marketHours';
import { fetchNews, NewsFetchResult } from '../news/pipeline';
import { a7Apply, dictionaryRadar, geminiRadarBatch, RadarReading } from '../llm/radar';
import { geminiAdvisor, clipAdvisorProposal, AdvisorProposal, ConstitutionClip } from '../llm/advisor';
import { geminiCritic, criticEffect, CriticTradeView } from '../llm/critic';
import { geminiStatusSync, aiBudgetUsedToday, aiBudgetLimit, providerBadge } from '../llm/gemini';
import { fmt_inr } from '../format';

export interface LiveDeps {
  /** injectable price source (tests: fixtures; prod: Yahoo) */
  priceFn?: (force?: boolean) => Promise<RealPrices | null>;
  /** injectable news source (tests: fixtures; prod: the pipeline) */
  newsFn?: (force?: boolean) => Promise<NewsFetchResult>;
  /** force rebalances past the market-hours gate (tests only — recorded) */
  allowClosedMarket?: boolean;
}

export interface AiProvenanceState {
  advisor: { day: number; bucket: string; action: string; valueCr: number; note: string }[];
  critic: { day: number; verdict: string; concern: string }[];
}

export interface LiveRadarLog {
  day: number;
  headline: string;
  reading: RadarReading;
  provider: 'gemini' | 'dictionary' | 'gemini-rejected';
  applied: boolean;
  rejectedByA7: boolean;
}

/** One executed paper trade, read back from the hash-chained recorder (the
 *  blotter IS the evidence — no parallel accounting). */
export interface LiveTrade {
  seq: number;
  day: number;
  kind: 'EXECUTION' | 'FORCED_SALE';
  bucket: string;
  dir: 1 | -1;
  valueCr: number;
  participation: number;
  impactCostCr: number;
  reason: string;
  origin: 'optimizer' | 'ai_advisor' | 'human' | 'forced';
  reClipped?: boolean;
}

export interface LiveState {
  sessionId: string;
  day: number;
  nav: number;
  navStart: number;
  navSeries: { day: number; nav: number; dd: number }[];
  regime: Regime;
  autonomy: AutonomyLevel;
  market: MarketStatus;
  book: {
    values: Record<BucketId, number>;
    weights: Record<BucketId, number>;
    prices: Record<BucketId, number>;
    cash: number;
    borrowings: number;
    postedMtf: number;
    postedCcil: number;
    gross: number;
    markSource: Record<BucketId, 'REAL' | 'MARK-TO-MODEL' | 'ACCRUAL'>;
    marginCumulative: number;
    impactPaid: number;
    forcedSaleEvents: number;
    maxParticipation: number;
  };
  risk: {
    cvar95: number;
    cvarLimit: number;
    ewmaPortfolioVolAnn: number;
    volRatio: number;
    liquidityDays: number;
    drawdown: number;
    maxDrawdown: number;
    /** the regime gross cap the optimizer is actually held to */
    grossCap: number;
  };
  /** cumulative sleeve performance since start (day 0 = 100), real marks */
  bucketPerf: Record<BucketId, number[]>;
  /** executed paper trades (recorder-derived) for the session blotter */
  trades: LiveTrade[];
  real: { eq: number; usdinr: number; goldInr: number; asOf: string; stale: boolean } | null;
  providers: {
    gemini: ReturnType<typeof geminiStatusSync>;
    badge: ReturnType<typeof providerBadge>;
    news: { degraded: boolean; articles: number; lastFetch: number | null };
    price: ReturnType<typeof priceStatus>;
    budget: { used: number; limit: number };
  };
  radar: RadarEvent[];
  radarLog: LiveRadarLog[];
  approvals: ApprovalCard[];
  constitution: { article: string; title: string; passed: boolean; detail: string; breached?: boolean }[];
  ai: {
    advisor: { day: number; bucket: string; action: string; valueCr: number; note: string }[];
    critic: { day: number; verdict: string; concern: string }[];
    lastAdvisorOutcome: string | null;
    lastCriticOutcome: string | null;
  };
  recorder: { entries: number; headHash: string; chainValid: boolean };
  lastRebalanceDay: number | null;
  lastRadarAt: number | null;
  status: string;
  disclaimer: string;
}

interface DayRecord {
  r: number[]; // bucket returns in BUCKETS order
  p: number; // portfolio return
  nav: number;
}

const RADAR_TTL_MS = 15 * 60_000;
const LEVELS: AutonomyLevel[] = ['FULL', 'SUPERVISED', 'CONSERVATIVE'];

export class LiveSession {
  id: string;
  seed: number;
  book: PaperBook;
  bot = new GovernedBot();
  metrics: MetricsEngine;
  recorder: FlightRecorder;
  day = 0;
  status: 'RUNNING' | 'STOPPED' = 'RUNNING';
  startedAt = Date.now();
  lastCycleIstDate: string | null = null;
  lastRebalanceDay: number | null = null;
  lastRadarAt: number | null = null;
  radarLog: LiveRadarLog[] = [];
  aiProvenance: AiProvenanceState = { advisor: [], critic: [] };
  lastAdvisorOutcome: string | null = null;
  lastCriticOutcome: string | null = null;
  postMortemCache: { markdown: string; provider: 'gemini' | 'template'; latencyMs: number } | null = null;
  private dayRets: DayRecord[] = [];
  private prevClosePrices: Record<BucketId, number>;
  private day0Weights: Record<BucketId, number>;
  private navStart: number;
  private deps: LiveDeps;
  private inflightRebalance: Promise<{ ok: boolean; reason?: string; trades: number }> | null = null;

  private constructor(id: string, seed: number, deps: LiveDeps) {
    this.id = id;
    this.seed = seed;
    this.deps = deps;
    this.book = new PaperBook(seed);
    const warmup = PaperBook.warmup(seed);
    const nav0 = this.book.nav();
    const w0 = {} as Record<BucketId, number>;
    for (const b of BUCKETS) w0[b] = this.book.bucketValue(b) / nav0;
    this.day0Weights = w0;
    this.metrics = new MetricsEngine(this.book.liveScenario, warmup, seed, w0);
    this.metrics.navSeries.push(nav0);
    this.navStart = nav0;
    this.prevClosePrices = { ...this.book.prices };
    this.recorder = new FlightRecorder(`LIVE-governed-s${seed}-${Math.floor(Date.now() / 1000)}`, true);
  }

  // ---------------------------------------------------------------- create / resume

  static async create(opts: { seed?: number; autonomy?: AutonomyLevel; deps?: LiveDeps } = {}): Promise<LiveSession> {
    const seed = opts.seed ?? SEED;
    const s = new LiveSession(await ensureSessionRow(), seed, opts.deps ?? {});
    if (opts.autonomy) s.bot.autonomy.setLevel(opts.autonomy, 0);
    s.recorder.record(
      0,
      'SESSION_START',
      {
        mode: 'live',
        seed,
        days: '∞ (live paper)',
        nav_day0: +(s.book.nav() / CR).toFixed(6),
        gross_day0_cr: +(s.book.gross() / CR).toFixed(4),
        borrowing_cr: +(s.book.borrowings / CR).toFixed(2),
        posted_ccil_cr: +(s.book.postedCcil / CR).toFixed(4),
        market_data: 'yahoo (^NSEI, USDINR=X, GC=F) + mark-to-model bonds',
        news: 'google-news-rss + gdelt (zero-key) [+ keyed providers if env]',
        disclaimer: 'educational paper simulation — no real orders, not investment advice',
      },
      { provider: 'kavach' }
    );
    await s.persistSnapshot();
    return s;

    async function ensureSessionRow(): Promise<string> {
      try {
        const { db } = await import('../../db');
        const row = await db.kavachSession.create({
          data: { kind: 'live', mode: 'governed', seed, autonomy: opts.autonomy ?? 'FULL', status: 'RUNNING', day: 0, navCr: null },
        });
        return row.id;
      } catch {
        return `live-${Date.now()}`;
      }
    }
  }

  private record = (kind: string, payload: Record<string, unknown>, meta?: Record<string, unknown>): void => {
    this.recorder.record(this.day, kind, payload, meta);
  };

  /** Durable state → JSON (everything needed to resume bit-exactly). */
  private snapshotPayload(): Record<string, unknown> {
    return {
      day: this.day,
      lastCycleIstDate: this.lastCycleIstDate,
      lastRebalanceDay: this.lastRebalanceDay,
      prevClosePrices: BUCKETS.map((b) => +this.prevClosePrices[b].toFixed(8)),
      day0Weights: BUCKETS.map((b) => +this.day0Weights[b].toFixed(8)),
      dayRets: this.dayRets,
      book: {
        units: BUCKETS.map((b) => +this.book.units[b].toFixed(8)),
        cash: this.book.cash,
        borrowings: this.book.borrowings,
        postedMtf: this.book.postedMtf,
        postedCcil: this.book.postedCcil,
        disloc: BUCKETS.map((b) => +this.book.disloc[b].toFixed(8)),
        clean: BUCKETS.map((b) => +this.book.clean[b].toFixed(8)),
        spreadFactor: this.book.spreadFactor,
        anchorReal: this.book.anchorReal,
        lastReal: this.book.lastReal,
        stats: {
          impactPaid: this.book.impactPaid,
          marginCumulative: this.book.marginCumulative,
          forcedSaleEvents: this.book.forcedSaleEvents,
          redemptionsMissed: this.book.redemptionsMissed,
          maxParticipation: this.book.maxParticipation,
        },
      },
      adapter: {
        advMult: this.book.liveScenario.advMult,
        mtfRatio: this.book.liveScenario.mtfRatio,
        ccilHaircut: this.book.liveScenario.ccilHaircut,
        lastMtfRatio: this.book.lastMtfRatio,
        lastCcilHaircut: this.book.lastCcilHaircut,
      },
      bot: {
        regime: this.bot.regimeMachine.serialize(),
        autonomy: this.bot.autonomy.serialize(),
        consent: this.bot.consent.serialize(),
        radarFeed: this.bot.radarFeed.slice(-120),
        articleFired: this.bot.articleFired.slice(-60),
        pendingTrades: [...this.bot.pendingTrades.entries()].map(([id, t]) => [id, t]),
        redemptionHistory: [],
      },
      aiProvenance: this.aiProvenance,
      radarLog: this.radarLog.slice(-120),
      recorder: { seq: this.recorder.size(), prevHash: this.recorder.headHash() },
      navStart: this.navStart,
      status: this.status,
    };
  }

  /** Persist a durable snapshot (public: API mode route + internals). */
  async persistSnapshot(): Promise<void> {
    try {
      const { db } = await import('../../db');
      const nav = this.book.nav();
      await db.bookSnapshot.upsert({
        where: { sessionId_day: { sessionId: this.id, day: this.day } },
        create: {
          sessionId: this.id,
          day: this.day,
          navCr: +(nav / CR).toFixed(6),
          grossCr: +(this.book.gross() / CR).toFixed(4),
          cashCr: +(this.book.cash / CR).toFixed(4),
          borrowCr: +(this.book.borrowings / CR).toFixed(4),
          regime: this.bot.regimeMachine.regime,
          payloadJson: JSON.stringify(this.snapshotPayload()),
        },
        update: {
          navCr: +(nav / CR).toFixed(6),
          grossCr: +(this.book.gross() / CR).toFixed(4),
          cashCr: +(this.book.cash / CR).toFixed(4),
          borrowCr: +(this.book.borrowings / CR).toFixed(4),
          regime: this.bot.regimeMachine.regime,
          payloadJson: JSON.stringify(this.snapshotPayload()),
        },
      });
      await db.kavachSession.update({
        where: { id: this.id },
        data: { day: this.day, navCr: +(nav / CR).toFixed(6), status: this.status, headHash: this.recorder.headHash(), recorderFile: this.recorder.fileError ? null : 'data/flightrecorder' },
      });
      await persistPendingApprovals(this);
    } catch {
      // persistence must never break the session
    }
  }

  /** Resume the latest RUNNING live session from the DB, or null. */
  static async resumeLatest(deps: LiveDeps = {}): Promise<LiveSession | null> {
    try {
      const { db } = await import('../../db');
      const rows = await db.kavachSession.findMany({
        where: { kind: 'live', status: 'RUNNING' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      for (const row of rows) {
        const snap = await db.bookSnapshot.findFirst({
          where: { sessionId: row.id },
          orderBy: { day: 'desc' },
        });
        if (!snap) continue;
        const p = JSON.parse(snap.payloadJson) as Record<string, unknown>;
        const s = new LiveSession(row.id, row.seed, deps);
        s.restore(p);
        const recPrev = (p as { recorder?: { prevHash?: string; seq?: number } }).recorder;
        s.recorder.record(
          s.day,
          'SESSION_RESUME',
          { day: s.day, nav_cr: +(s.book.nav() / CR).toFixed(4), entries_before: recPrev?.seq ?? 0 },
          { provider: 'kavach' }
        );
        return s;
      }
      return null;
    } catch {
      return null;
    }
  }

  private restore(p: Record<string, unknown>): void {
    const g = p as {
      day: number;
      lastCycleIstDate: string | null;
      lastRebalanceDay: number | null;
      prevClosePrices: number[];
      day0Weights: number[];
      dayRets: DayRecord[];
      book: {
        units: number[];
        cash: number;
        borrowings: number;
        postedMtf: number;
        postedCcil: number;
        disloc: number[];
        clean: number[];
        spreadFactor: Record<string, number>;
        anchorReal: { eq: number; usdinr: number; goldUsd: number } | null;
        lastReal: { eq: number; usdinr: number; goldUsd: number; at: string } | null;
        stats: { impactPaid: number; marginCumulative: number; forcedSaleEvents: number; redemptionsMissed: number; maxParticipation: number };
      };
      adapter: { advMult: number; mtfRatio: number; ccilHaircut: number; lastMtfRatio: number; lastCcilHaircut: number };
      bot: {
        regime: ReturnType<never> | Record<string, unknown>;
        autonomy: Record<string, unknown>;
        consent: Record<string, unknown>;
        radarFeed: RadarEvent[];
        articleFired: { day: number; article: string; detail: string }[];
        pendingTrades: [string, TradeIntent][];
      };
      aiProvenance: AiProvenanceState;
      radarLog: LiveRadarLog[];
      recorder: { seq: number; prevHash: string };
      navStart: number;
      status: string;
    };
    this.day = g.day;
    this.lastCycleIstDate = g.lastCycleIstDate;
    this.lastRebalanceDay = g.lastRebalanceDay;
    this.dayRets = g.dayRets ?? [];
    this.navStart = g.navStart;
    BUCKETS.forEach((b, i) => {
      this.prevClosePrices[b] = g.prevClosePrices[i];
      this.day0Weights[b] = g.day0Weights[i];
      this.book.units[b] = g.book.units[i];
      this.book.disloc[b] = g.book.disloc[i];
      this.book.clean[b] = g.book.clean[i];
      this.book.prices[b] = this.book.clean[b] * this.book.disloc[b];
    });
    this.book.cash = g.book.cash;
    this.book.borrowings = g.book.borrowings;
    this.book.postedMtf = g.book.postedMtf;
    this.book.postedCcil = g.book.postedCcil;
    this.book.spreadFactor = g.book.spreadFactor;
    this.book.anchorReal = g.book.anchorReal;
    this.book.lastReal = g.book.lastReal;
    this.book.impactPaid = g.book.stats.impactPaid;
    this.book.marginCumulative = g.book.stats.marginCumulative;
    this.book.forcedSaleEvents = g.book.stats.forcedSaleEvents;
    this.book.redemptionsMissed = g.book.stats.redemptionsMissed;
    this.book.maxParticipation = g.book.stats.maxParticipation;
    this.book.liveScenario.advMult = g.adapter.advMult;
    this.book.liveScenario.mtfRatio = g.adapter.mtfRatio;
    this.book.liveScenario.ccilHaircut = g.adapter.ccilHaircut;
    this.book.lastMtfRatio = g.adapter.lastMtfRatio;
    this.book.lastCcilHaircut = g.adapter.lastCcilHaircut;
    this.bot.regimeMachine.restore(g.bot.regime as never);
    this.bot.autonomy.restore(g.bot.autonomy as never);
    this.bot.consent.restore(g.bot.consent as never);
    this.bot.radarFeed = g.bot.radarFeed ?? [];
    this.bot.articleFired = g.bot.articleFired ?? [];
    this.bot.pendingTrades = new Map(g.bot.pendingTrades ?? []);
    this.aiProvenance = g.aiProvenance ?? this.aiProvenance;
    this.radarLog = g.radarLog ?? [];
    this.status = (g.status as 'RUNNING' | 'STOPPED') ?? 'RUNNING';
    // rebuild metrics deterministically: warmup + replay stored daily returns
    const warmup = PaperBook.warmup(this.seed);
    this.metrics = new MetricsEngine(this.book.liveScenario, warmup, this.seed, this.day0Weights);
    this.metrics.navSeries.push(this.navStart);
    for (const d of this.dayRets) {
      const rets = {} as Record<BucketId, number>;
      BUCKETS.forEach((b, i) => (rets[b] = d.r[i]));
      this.metrics.updateDay(rets, d.p, d.nav);
    }
    // recorder: continue the hash chain (never reset)
    const rec = (p as { recorder?: { prevHash?: string; seq?: number } }).recorder;
    this.recorder = new FlightRecorder(`LIVE-governed-s${this.seed}-resume-${Math.floor(Date.now() / 1000)}`, true, {
      prevHash: rec?.prevHash ?? '',
      seq: rec?.seq ?? 0,
    });
  }

  // ---------------------------------------------------------------- polling

  /** Re-mark the book to real prices (cached 10 min). Safe to call often. */
  async pollPrices(force = false): Promise<RealPrices | null> {
    const fn = this.deps.priceFn ?? fetchRealPrices;
    const real = await fn(force);
    if (real) this.book.markToReal(real);
    return real;
  }

  /**
   * Refresh the radar from real news (15-min cadence). Gemini batched call
   * when the key is present and the budget allows; dictionary per headline
   * otherwise (A9). Tighten-only application (A7); severity ≥ 4 also nudges
   * the autonomy dial toward scrutiny (never away). All events persisted.
   */
  async refreshRadar(force = false): Promise<LiveRadarLog[]> {
    const now = Date.now();
    if (!force && this.lastRadarAt && now - this.lastRadarAt < RADAR_TTL_MS) return [];
    const fn = this.deps.newsFn ?? fetchNews;
    const res = await fn(false);
    this.lastRadarAt = now;
    const headlines = res.articles.slice(0, 25);
    if (headlines.length === 0) return [];

    const gemini = geminiStatusSync();
    const useGemini = gemini.state === 'ok' || (gemini.state !== 'nokey' && gemini.state !== 'budget');
    let readings: RadarReading[] = [];
    let indices: number[] = [];
    let provider: 'gemini' | 'dictionary' = 'dictionary';
    if (useGemini) {
      const batch = await geminiRadarBatch(
        headlines.map((a, i) => ({ index: i, title: a.title, url: a.url, source: a.source }))
      );
      if (batch.ok) {
        readings = batch.readings;
        indices = batch.headlineIndices;
        provider = 'gemini';
      } else if (batch.outcome === 'rejected' || batch.outcome === 'fallback') {
        provider = 'dictionary';
      }
    }
    // dictionary fill for headlines Gemini skipped (or the whole batch on fallback)
    headlines.forEach((a, i) => {
      if (provider === 'dictionary' || !indices.includes(i)) {
        const d = dictionaryRadar(a.title);
        readings.push({ ...d, sourceUrl: a.url });
        indices.push(i);
      }
    });

    const logs: LiveRadarLog[] = [];
    let notched = false;
    for (let k = 0; k < readings.length; k++) {
      const reading = readings[k];
      const h = headlines[indices[k] % headlines.length];
      const a7 = a7Apply(reading);
      const log: LiveRadarLog = {
        day: this.day,
        headline: h?.title ?? reading.event,
        reading,
        provider,
        applied: a7.applied,
        rejectedByA7: a7.rejectedByA7,
      };
      this.radarLog.push(log);
      this.bot.radarFeed.push({
        day: this.day,
        headline: log.headline,
        event: reading.event,
        severity: reading.severity,
        buckets: reading.buckets,
        direction: reading.direction,
        confidence: reading.confidence,
        source: h?.source ?? reading.source,
        provider,
        applied: a7.applied,
      } as RadarEvent);
      this.record(
        a7.rejectedByA7 ? 'REJECTED_BY_A7' : 'RADAR',
        {
          day: this.day,
          headline: log.headline,
          provider,
          event: reading.event,
          severity: reading.severity,
          direction: reading.direction,
          buckets: reading.buckets,
          confidence: +reading.confidence.toFixed(3),
          applied: a7.applied,
          reason: a7.reason,
          source_url: h?.url,
        },
        { provider, latencyMs: 0 }
      );
      if (a7.rejectedByA7) continue; // A7 absolute: rejected, recorded, inert
      if (a7.applied) {
        // tighten-only effects
        this.bot.regimeMachine.applyRadarSeverity(reading.severity);
        this.book.applyRadarMargin(reading);
        this.book.applyRadarMark(reading);
        // severity ≥ 4 → autonomy one notch toward scrutiny (once per refresh,
        // not once per event — the dial moves, it never sprints)
        if (reading.severity >= 4 && !notched) {
          notched = true;
          const idx = LEVELS.indexOf(this.bot.autonomy.level);
          if (idx < LEVELS.length - 1) this.bot.autonomy.setLevel(LEVELS[idx + 1], this.day);
        }
      }
      await persistRadarEvent(this, log);
    }
    return logs;
  }

  /**
   * Advance the trading day (once per IST market date, only while the market
   * is open): margin calls on T-1 marks → model decay → re-mark → metrics
   * → observation entry → snapshot. No trading here (that's rebalance).
   */
  async advanceDayIfNeeded(): Promise<boolean> {
    const market = marketStatus();
    if (!market.open && !this.deps.allowClosedMarket) return false;
    if (this.lastCycleIstDate === market.istDate) return false;
    const d = this.day + 1;
    this.book.setRegime(this.bot.regimeMachine.regime);
    // 1) open: interest + margin channels on T-1 closes
    const events = this.book.stepOpen(d, 'governed');
    this.day = d;
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
      } else if (m.released > 0) {
        this.record('MARGIN_RELEASE', { day: d, channel: m.channel, released_cr: +(m.released / CR).toFixed(4), posted_after_cr: +(m.posted / CR).toFixed(3) });
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
    // 2) day rollover: decay impact dislocations + spread/margin models, sweep
    for (const b of BUCKETS) {
      if (b === 'LIQ') continue;
      this.book.disloc[b] = 1 + (this.book.disloc[b] - 1) * 0.9;
    }
    this.book.decayModels();
    this.book.sweepCashToLiq();
    // 3) re-mark to the latest real prices
    await this.pollPrices();
    // 4) metrics on the day's close-to-close moves
    const bucketRets = {} as Record<BucketId, number>;
    for (const b of BUCKETS) bucketRets[b] = this.book.prices[b] / this.prevClosePrices[b] - 1;
    const nav = this.book.nav();
    this.metrics.updateDay(bucketRets, nav / this.metrics.navSeries[this.metrics.navSeries.length - 1] - 1, nav);
    this.dayRets.push({ r: BUCKETS.map((b) => bucketRets[b]), p: nav / this.metrics.navSeries[this.metrics.navSeries.length - 2] - 1, nav });
    for (const b of BUCKETS) this.prevClosePrices[b] = this.book.prices[b];
    this.lastCycleIstDate = market.istDate;
    // 5) expire approvals whose deadline passed (timeout ⇒ no trade)
    this.bot.expireApprovals(this.book, this.record);
    // 6) observation + snapshot
    this.record('OBSERVATION', {
      day: d,
      nav_cr: +(nav / CR).toFixed(4),
      gross_cr: +(this.book.gross() / CR).toFixed(3),
      cash_cr: +(this.book.cash / CR).toFixed(4),
      borrowings_cr: +(this.book.borrowings / CR).toFixed(3),
      posted_mtf_cr: +(this.book.postedMtf / CR).toFixed(4),
      posted_ccil_cr: +(this.book.postedCcil / CR).toFixed(4),
      ledger_residual: this.book.ledgerResidual(),
      regime: this.bot.regimeMachine.regime,
      drawdown: +this.metrics.drawdown().toFixed(5),
      vol_ratio: +this.metrics.lastVolRatio.toFixed(3),
      nav_str: fmt_inr(nav),
      ist_date: market.istDate,
      prices: BUCKETS.map((b) => +this.book.prices[b].toFixed(6)),
      values_cr: BUCKETS.map((b) => +(this.book.bucketValue(b) / CR).toFixed(3)),
    });
    await this.persistSnapshot();
    return true;
  }

  // ---------------------------------------------------------------- rebalance (the decision loop)

  /**
   * The full LIVE decision loop. Guarded by market hours (force = tests,
   * recorded as forced). Concurrent callers share one in-flight run.
   */
  async rebalance(force = false): Promise<{ ok: boolean; reason?: string; trades: number }> {
    if (this.inflightRebalance) return this.inflightRebalance;
    const p = this.doRebalance(force);
    this.inflightRebalance = p;
    try {
      return await p;
    } finally {
      this.inflightRebalance = null;
    }
  }

  private async doRebalance(force: boolean): Promise<{ ok: boolean; reason?: string; trades: number }> {
    const market = marketStatus();
    if (!market.open && !force && !this.deps.allowClosedMarket) {
      return { ok: false, reason: `MARKET CLOSED — ${market.reason}; no rebalance fires outside 09:15–15:30 IST`, trades: 0 };
    }
    if (force) {
      this.record('FORCED_ACTION', { day: this.day, action: 'rebalance', note: 'forced past the market-hours gate (test/admin)' });
    } else if (!market.open && this.deps.allowClosedMarket) {
      this.record('FORCED_ACTION', { day: this.day, action: 'rebalance', note: 'allowClosedMarket dep bypassed the gate (test)' });
    }
    // 1) news → radar (15-min cadence, tighten-only)
    await this.refreshRadar();
    // 2) day cycle if a new IST market date has opened
    await this.advanceDayIfNeeded();
    // 3) freshest marks
    await this.pollPrices();
    this.book.setRegime(this.bot.regimeMachine.regime);
    if (this.book.nav() <= 0) return { ok: false, reason: 'NAV non-positive', trades: 0 };

    // 4) AI Advisor (once per rebalance decision; budget-gated; SKIPPED, never errored)
    const gemini = geminiStatusSync();
    let advisorInputs: { proposals: AdvisorProposal[]; clips: ConstitutionClip[]; outcome: string; latencyMs: number } | null = null;
    if (gemini.state === 'ok' || (gemini.state !== 'nokey' && gemini.state !== 'budget')) {
      const values = {} as Record<BucketId, number>;
      const vols = {} as Record<BucketId, number>;
      const advs = {} as Record<BucketId, number>;
      for (const b of BUCKETS) {
        values[b] = this.book.bucketValue(b);
        vols[b] = this.metrics.ewmaVol(b);
        advs[b] = this.book.adv(b);
      }
      const regime = this.bot.regimeMachine.regime;
      const scenarios = this.metrics.scenarioMatrix(regime, this.day);
      const weights = {} as Record<BucketId, number>;
      for (const b of BUCKETS) weights[b] = values[b] / Math.max(this.book.nav(), 1);
      const res = await geminiAdvisor({
        nav: this.book.nav(),
        regime,
        autonomy: this.bot.autonomy.level,
        values,
        vols,
        cvar95: this.metrics.cvar95(weights, scenarios),
        cvarLimit: this.metrics.cvarLimit(regime),
        liq: values['LIQ'],
        liqFloor: 0.05,
        borrowings: this.book.borrowings,
        radar: this.bot.radarFeed.slice(-5).map((r) => ({ event: r.event, severity: r.severity, buckets: r.buckets, direction: r.direction })),
        advs,
      });
      this.lastAdvisorOutcome = res.outcome;
      if (res.ok) {
        const clips = res.proposals.map((pr) =>
          clipAdvisorProposal(pr, { advs, values, nav: this.book.nav() }).clip
        );
        advisorInputs = { proposals: res.proposals, clips, outcome: res.outcome, latencyMs: res.latencyMs };
      } else {
        this.record('AI_ADVISOR', { day: this.day, status: 'SKIPPED', outcome: res.outcome, reason: res.reason?.slice(0, 200) });
      }
    } else {
      this.lastAdvisorOutcome = gemini.state === 'budget' ? 'budget' : 'nokey';
      this.record('AI_ADVISOR', { day: this.day, status: 'SKIPPED', outcome: this.lastAdvisorOutcome, reason: `gemini ${gemini.state}` });
    }
    this.bot.aiInputs = advisorInputs ? { advisor: advisorInputs } : null;

    // 5) prepare (regime → optimizer → AI merge → constitution A1–A9)
    const plan = this.bot.prepareRebalance(this.book, this.metrics, this.day, this.record);
    this.bot.aiInputs = null; // one-shot: never leaks into the next decision
    // 6) Critic challenge on the chosen list (async gap — zero authority)
    let escalation: CriticEscalation | null = null;
    if (plan.blocked.length === 0 && plan.intents.length > 0) {
      const geminiNow = geminiStatusSync();
      if (geminiNow.state === 'ok' || (geminiNow.state !== 'nokey' && geminiNow.state !== 'budget')) {
        const views: CriticTradeView[] = plan.intents.map((t) => ({
          origin: t.origin === 'ai_advisor' ? 'ai_advisor' : 'optimizer',
          bucket: t.bucket,
          action: t.direction === 1 ? 'buy' : 'sell',
          valueCr: t.value / CR,
          participation: t.participation,
        }));
        const weights = {} as Record<BucketId, number>;
        for (const b of BUCKETS) weights[b] = this.book.bucketValue(b) / Math.max(this.book.nav(), 1);
        const critic = await geminiCritic(views, {
          regime: plan.regime,
          cvar95: this.metrics.cvar95(weights, plan.scenarios),
          cvarLimit: this.metrics.cvarLimit(plan.regime),
          liqFrac: this.book.liqValue() / Math.max(this.book.nav(), 1),
          navCr: this.book.nav() / CR,
          radar: this.bot.radarFeed.slice(-4).map((r) => ({ event: r.event, severity: r.severity })),
        });
        this.lastCriticOutcome = critic.outcome;
        const effect = criticEffect(critic);
        escalation = effect.escalateAll || effect.escalateBuckets.length > 0
          ? { all: effect.escalateAll, buckets: effect.escalateBuckets }
          : null;
        this.record(
          'AI_CRITIC',
          {
            day: this.day,
            verdict: critic.verdict,
            worst_bucket: critic.worstBucket,
            concerns: critic.concerns.slice(0, 5),
            ignored_risk: critic.ignoredRisk.slice(0, 200),
            effect: { escalate_all: effect.escalateAll, escalate_buckets: effect.escalateBuckets },
            outcome: critic.outcome,
          },
          { provider: 'gemini', latencyMs: critic.latencyMs }
        );
        if (critic.ok) {
          for (const c of critic.concerns.slice(0, 3)) {
            this.aiProvenance.critic.push({ day: this.day, verdict: critic.verdict, concern: c.concern });
          }
        }
      } else {
        this.lastCriticOutcome = geminiNow.state === 'budget' ? 'budget' : 'nokey';
        this.record('AI_CRITIC', { day: this.day, status: 'SKIPPED', outcome: this.lastCriticOutcome, reason: `gemini ${geminiNow.state}` });
      }
    }

    // 7) consent gates + execution + repay (same engine as REPLAY)
    const tradesBefore = this.recorder
      .all()
      .filter((e) => e.kind === 'EXECUTION' && e.day === this.day).length;
    this.bot.finalizeRebalance(this.book, this.metrics, this.day, this.record, plan, escalation);
    const tradesAfter = this.recorder
      .all()
      .filter((e) => e.kind === 'EXECUTION' && e.day === this.day).length;

    // provenance for the narrator
    if (advisorInputs) {
      advisorInputs.proposals.forEach((pr, i) => {
        const clip = advisorInputs!.clips[i];
        if (clip && !clip.rejected && clip.clippedToCr > 0.5) {
          this.aiProvenance.advisor.push({
            day: this.day,
            bucket: pr.bucket,
            action: pr.action,
            valueCr: clip.clippedToCr,
            note: clip.reason,
          });
        }
      });
    }
    this.lastRebalanceDay = this.day;
    this.book.setRegime(this.bot.regimeMachine.regime);
    await this.persistSnapshot();
    return { ok: true, trades: tradesAfter - tradesBefore };
  }

  // ---------------------------------------------------------------- approvals

  async decide(id: string, decision: 'APPROVED' | 'REJECTED'): Promise<boolean> {
    const ok = this.bot.decide(id, decision, this.book, this.record);
    if (ok) await this.persistSnapshot();
    return ok;
  }

  async stop(): Promise<void> {
    this.status = 'STOPPED';
    this.record('SESSION_END', {
      day: this.day,
      nav_end_cr: +(this.book.nav() / CR).toFixed(4),
      nav_total_ret: +(this.book.nav() / this.navStart - 1).toFixed(5),
      max_drawdown: +this.metrics.maxDrawdown().toFixed(5),
      margin_cumulative_cr: +(this.book.marginCumulative / CR).toFixed(4),
      impact_paid_cr: +(this.book.impactPaid / CR).toFixed(4),
      recorder_entries: this.recorder.size(),
      head_hash: this.recorder.headHash(),
    });
    await this.persistSnapshot();
  }

  // ---------------------------------------------------------------- post-mortem

  async generatePostMortem(useLlm = true): Promise<NonNullable<LiveSession['postMortemCache']>> {
    if (this.postMortemCache) return this.postMortemCache;
    const input = {
      scenario: 'LIVE' as const,
      story:
        'LIVE PAPER: the ₹1,000 Cr book marked to real market data (Yahoo: ^NSEI, USDINR=X, GC=F; ' +
        'bond sleeves mark-to-model from radar events; LIQ accrues ~4% p.a.), governed through the ' +
        'same constitution as the crisis replays, with real news perceived by Gemini and AI voices ' +
        '(Advisor + Critic) inside the loop at zero authority.',
      days: this.day,
      governed: {
        navEnd: this.book.nav(),
        maxDrawdown: this.metrics.maxDrawdown(),
        impactPaid: this.book.impactPaid,
        forcedSaleEvents: this.book.forcedSaleEvents,
        maxParticipation: this.book.maxParticipation,
        marginCumulative: this.book.marginCumulative,
        articleFired: this.bot.articleFired.slice(-12),
        regimePath: this.bot.radarFeed.length ? [this.bot.regimeMachine.regime] : ['CALM'],
        approvalsApproved: this.bot.consent.all().filter((c) => c.status === 'APPROVED').length,
        approvalsRejected: this.bot.consent.all().filter((c) => c.status === 'REJECTED').length,
        approvalsTimedOut: this.bot.consent.all().filter((c) => c.status === 'TIMEOUT').length,
      },
      newsCitations: this.radarLog
        .filter((l) => l.applied || l.rejectedByA7)
        .slice(-6)
        .map((l) => ({ day: l.day, headline: l.headline, severity: l.reading.severity, url: l.reading.sourceUrl })),
      aiProvenance: {
        advisorProposals: this.aiProvenance.advisor.map((a) => ({
          day: a.day,
          bucket: a.bucket,
          direction: a.action,
          valueCr: a.valueCr,
          capped: a.note,
        })),
        criticConcerns: this.aiProvenance.critic.map((c) => ({ day: c.day, concern: `${c.verdict}: ${c.concern}` })),
      },
    };
    if (!useLlm) {
      const { templatePostMortem } = await import('../llm/narrator');
      this.postMortemCache = { markdown: templatePostMortem(input), provider: 'template', latencyMs: 0 };
      return this.postMortemCache;
    }
    const { llmPostMortem } = await import('../llm/narrator');
    const res = await llmPostMortem(input);
    this.postMortemCache = { markdown: res.markdown, provider: res.provider, latencyMs: res.latencyMs };
    return this.postMortemCache;
  }

  // ---------------------------------------------------------------- state

  state(): LiveState {
    const market = marketStatus();
    const nav = this.book.nav();
    const values = {} as Record<BucketId, number>;
    const weights = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      values[b] = this.book.bucketValue(b);
      weights[b] = values[b] / Math.max(nav, 1);
    }
    const regime = this.bot.regimeMachine.regime;
    const markSource: Record<BucketId, 'REAL' | 'MARK-TO-MODEL' | 'ACCRUAL'> = {
      EQ: 'REAL',
      GOLD: 'REAL',
      GSEC: 'MARK-TO-MODEL',
      IGCORP: 'MARK-TO-MODEL',
      CRED: 'MARK-TO-MODEL',
      LIQ: 'ACCRUAL',
    };
    const navSeries = [
      { day: 0, nav: this.navStart, dd: 0 },
      ...this.dayRets.map((d, i) => ({ day: i + 1, nav: d.nav, dd: 0 })),
    ];
    // drawdown series
    let peak = -Infinity;
    for (const pt of navSeries) {
      peak = Math.max(peak, pt.nav);
      pt.dd = pt.nav / peak - 1;
    }
    const gemini = geminiStatusSync();
    const budget = { used: -1, limit: aiBudgetLimit() };
    const scenarios = this.metrics.scenarioMatrix(regime, this.day);
    const liq = this.metrics.liquidity(values, nav, (b) => this.book.adv(b));
    // cumulative sleeve performance since start (day 0 = 100) — REAL marks
    const bucketPerf = {} as Record<BucketId, number[]>;
    for (const b of BUCKETS) {
      const series: number[] = [100];
      let idx = 100;
      for (const dr of this.dayRets) {
        idx *= 1 + dr.r[BUCKETS.indexOf(b)];
        series.push(+idx.toFixed(4));
      }
      bucketPerf[b] = series;
    }
    // session blotter: executed trades read straight from the recorder
    const trades: LiveTrade[] = this.recorder
      .all()
      .filter((e) => (e.kind === 'EXECUTION' || e.kind === 'FORCED_SALE') && typeof e.payload.bucket === 'string')
      .slice(-100)
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        const reason = String(p.reason ?? '');
        const origin: LiveTrade['origin'] =
          e.kind === 'FORCED_SALE'
            ? 'forced'
            : p.origin === 'ai_advisor' || reason.includes('ai-advisor')
              ? 'ai_advisor'
              : reason.includes('human-approved')
                ? 'human'
                : 'optimizer';
        return {
          seq: e.seq,
          day: e.day,
          kind: e.kind as LiveTrade['kind'],
          bucket: String(p.bucket),
          dir: (p.dir === 1 ? 1 : -1) as 1 | -1,
          valueCr: Number(p.value_cr ?? 0),
          participation: Number(p.participation ?? 0),
          impactCostCr: Number(p.impact_cost_cr ?? 0),
          reason,
          origin,
          reClipped: p.re_clipped_to_a3 === true,
        };
      });
    return {
      sessionId: this.id,
      day: this.day,
      nav,
      navStart: this.navStart,
      navSeries,
      regime,
      autonomy: this.bot.autonomy.level,
      market,
      book: {
        values,
        weights,
        prices: { ...this.book.prices },
        cash: this.book.cash,
        borrowings: this.book.borrowings,
        postedMtf: this.book.postedMtf,
        postedCcil: this.book.postedCcil,
        gross: this.book.gross(),
        markSource,
        marginCumulative: this.book.marginCumulative,
        impactPaid: this.book.impactPaid,
        forcedSaleEvents: this.book.forcedSaleEvents,
        maxParticipation: this.book.maxParticipation,
      },
      risk: {
        cvar95: this.metrics.cvar95(weights, scenarios),
        cvarLimit: this.metrics.cvarLimit(regime),
        ewmaPortfolioVolAnn: this.metrics.ewmaPortfolioVol() * Math.sqrt(250),
        volRatio: this.metrics.lastVolRatio,
        liquidityDays: liq.portfolioDays,
        drawdown: this.metrics.drawdown(),
        maxDrawdown: this.metrics.maxDrawdown(),
        grossCap: GROSS_CAP[regime],
      },
      bucketPerf,
      trades,
      real: this.book.lastReal
        ? {
            eq: this.book.lastReal.eq,
            usdinr: this.book.lastReal.usdinr,
            goldInr: this.book.lastReal.goldUsd * this.book.lastReal.usdinr,
            asOf: this.book.lastReal.at,
            stale: priceStatus().state === 'stale',
          }
        : null,
      providers: {
        gemini,
        badge: providerBadge(gemini),
        news: { degraded: false, articles: 0, lastFetch: null },
        price: priceStatus(),
        budget,
      },
      radar: this.bot.radarFeed.slice(-40),
      radarLog: this.radarLog.slice(-40),
      approvals: this.bot.consent.recent(30),
      constitution: this.bot.constitutionChecks,
      ai: {
        advisor: this.aiProvenance.advisor.slice(-12),
        critic: this.aiProvenance.critic.slice(-12),
        lastAdvisorOutcome: this.lastAdvisorOutcome,
        lastCriticOutcome: this.lastCriticOutcome,
      },
      recorder: {
        entries: this.recorder.size(),
        headHash: this.recorder.headHash(),
        chainValid: this.recorder.verify(),
      },
      lastRebalanceDay: this.lastRebalanceDay,
      lastRadarAt: this.lastRadarAt,
      status: this.status,
      disclaimer:
        'LIVE PAPER — educational simulation on real market data. It never places real orders. It is not investment advice.',
    };
  }
}

// ---------------------------------------------------------------- DB helpers

async function persistRadarEvent(s: LiveSession, log: LiveRadarLog): Promise<void> {
  try {
    const { db } = await import('../../db');
    await db.radarEventRow.create({
      data: {
        sessionId: s.id,
        day: log.day,
        event: log.reading.event.slice(0, 300),
        severity: log.reading.severity,
        buckets: JSON.stringify(log.reading.buckets),
        direction: log.reading.direction,
        confidence: log.reading.confidence,
        sourceUrl: log.reading.sourceUrl ?? undefined,
        provider: log.provider,
        applied: log.applied,
      },
    });
  } catch {
    // non-fatal
  }
}

async function persistPendingApprovals(s: LiveSession): Promise<void> {
  try {
    const { db } = await import('../../db');
    const cards = s.bot.consent.all();
    for (const c of cards) {
      const trade = s.bot.pendingTrades.get(c.id);
      const row = {
        sessionId: s.id,
        day: c.day,
        deadlineDay: c.deadlineDay,
        bucket: c.trade.bucket,
        valueCr: +(c.trade.value / CR).toFixed(4),
        direction: c.trade.direction,
        regime: c.regime,
        origin: trade?.origin ?? 'optimizer',
        articlesJson: JSON.stringify(c.articlesInvoked),
        counterfactualJson: JSON.stringify(c.counterfactual),
        tradeJson: trade ? JSON.stringify(trade) : null,
        status: c.status,
        decidedBy: c.decidedBy ?? null,
      };
      await db.approvalRow.upsert({
        where: { id: c.id },
        create: { id: c.id, ...row },
        update: row,
      });
    }
  } catch {
    // non-fatal: the recorder remains the source of truth for evidence
  }
}

/** Budget + news status enrichment (called by the API layer, post-hoc). */
export async function enrichState(st: LiveState): Promise<LiveState> {
  st.providers.budget.used = await aiBudgetUsedToday();
  try {
    const { newsStatuses, cachedNews } = await import('../news/pipeline');
    st.providers.news = {
      degraded: st.providers.news.degraded,
      articles: cachedNews().length,
      lastFetch: Math.max(0, ...newsStatuses().map((s) => s.lastFetch ?? 0)) || null,
    };
  } catch {
    // keep defaults
  }
  return st;
}
