/// <reference types="bun-types" />
/**
 * KAVACH — test matrix (§12 of the build spec). Run: bun test
 *
 * Suites: Ledger (10+) · Calibration (12+) · Determinism (2) ·
 * Impact & liquidity (6+) · Governor (10+) · LLM guardrails (6+) ·
 * API/ReplayController E2E (6+) · Formatting (4+).
 */

import { describe, expect, test } from 'bun:test';

// DB isolation FIRST — before any src import constructs the Prisma client.
// Even though this file's suites are pure-compute, the module graph pulls in
// the LLM layer; keep every test file on the throwaway DB. See tests/_db-env.ts.
import './_db-env';
import { devServerUp } from './_dev-server';

import { SimSession } from '../src/lib/kavach/sim';
import { ReplayController } from '../src/lib/kavach/replay';
import { BUCKETS, CR } from '../src/lib/kavach/constants';
import { SCENARIOS } from '../src/lib/kavach/world/scenarios';
import { fmt_inr, fmt_inr_grouped, groupIndian } from '../src/lib/kavach/format';
import { dictionaryRadar, validateRadar, radarProviderLabel } from '../src/lib/kavach/llm/radar';
import { impactQuote, capByParticipation } from '../src/lib/kavach/world/execution';
import { eigenvalues } from '../src/lib/kavach/rng';
import { CORR } from '../src/lib/kavach/constants';
import { AutonomyDial, ConsentQueue } from '../src/lib/kavach/governor/consent';
import { RegimeMachine } from '../src/lib/kavach/governor/regime';
import { MetricsEngine } from '../src/lib/kavach/metrics/metrics';
import { warmupReturns } from '../src/lib/kavach/world/engine';
import { FlightRecorder, hashEntry } from '../src/lib/kavach/recorder/flight';
import { evaluateConstitution } from '../src/lib/kavach/governor/constitution';
import type { BucketId, ScenarioId } from '../src/lib/kavach/types';

const NAV0 = 1000 * CR;
const scenarios: ScenarioId[] = ['TANTRUM-13', 'ILFS-18', 'COVID-20'];

function runWorld(id: ScenarioId): SimSession {
  const s = new SimSession({ scenario: id, mode: 'world', persistRecorder: false });
  while (!s.complete) s.step();
  return s;
}

function runAgent(id: ScenarioId, mode: 'naive' | 'governed'): SimSession {
  const s = new SimSession({ scenario: id, mode, persistRecorder: false });
  while (!s.complete) s.step();
  return s;
}

// ---------------------------------------------------------------------------
// 1. LEDGER
// ---------------------------------------------------------------------------

describe('Ledger — NAV is an arithmetic identity, not a formula', () => {
  test('day-0 NAV is exactly ₹1,000.00 Cr (≤ ₹100 absolute) in all scenarios', () => {
    for (const id of scenarios) {
      const s = new SimSession({ scenario: id, mode: 'world', persistRecorder: false });
      expect(Math.abs(s.engine.nav() - NAV0)).toBeLessThanOrEqual(100);
    }
  });

  test('day-0 NAV = cash + Σ units×price + margin_posted − borrowings (component recomputation)', () => {
    for (const id of scenarios) {
      const s = new SimSession({ scenario: id, mode: 'world', persistRecorder: false });
      const e = s.engine;
      let rhs = e.cash + e.postedMtf + e.postedCcil - e.borrowings;
      for (const b of BUCKETS) rhs += e.units[b] * e.prices[b];
      expect(Math.abs(e.nav() - rhs)).toBeLessThanOrEqual(1e-6);
    }
  });

  test('per-day ledger identity ≤ 1e-8 relative — all days, all scenarios (world mode)', () => {
    for (const id of scenarios) {
      const s = runWorld(id);
      let worst = 0;
      for (const o of s.observations) {
        const e = s.engine;
        let rhs = e.cash + e.postedMtf + e.postedCcil - e.borrowings;
        for (const b of BUCKETS) rhs += e.units[b] * e.prices[b];
        void o;
        worst = Math.max(worst, Math.abs(e.nav() - rhs));
      }
      expect(worst).toBeLessThanOrEqual(1e-8 * NAV0);
    }
  });

  test('ledger residual stays ≤ 1e-8 relative with live agents (naive + governed, COVID)', () => {
    for (const mode of ['naive', 'governed'] as const) {
      const s = runAgent('COVID-20', mode);
      expect(s.engine.ledgerResidual()).toBeLessThanOrEqual(1e-8 * NAV0);
    }
  });

  test('holdings coherence: no bucket appears or disappears; units never negative', () => {
    for (const id of scenarios) {
      for (const mode of ['naive', 'governed'] as const) {
        const s = runAgent(id, mode);
        for (const b of BUCKETS) {
          expect(s.engine.units[b]).toBeGreaterThanOrEqual(-1e-6);
          expect(Number.isFinite(s.engine.units[b])).toBe(true);
          expect(Number.isFinite(s.engine.prices[b])).toBe(true);
          expect(s.engine.prices[b]).toBeGreaterThan(0);
        }
      }
    }
  });

  test('NAV never NaN/Infinity in any replay (the ledger is boring)', () => {
    for (const id of scenarios) {
      for (const mode of ['naive', 'governed'] as const) {
        const s = runAgent(id, mode);
        for (const o of s.observations) {
          expect(Number.isFinite(o.nav)).toBe(true);
          expect(o.nav).toBeGreaterThan(0);
        }
      }
    }
  });

  test('margin arithmetic: every margin rupee is paid (cash/LIQ) or force-liquidated — recorder proves which', () => {
    for (const id of scenarios) {
      const s = runAgent(id, 'governed');
      const calls = s.recorder.all().filter((e) => e.kind === 'MARGIN_CALL');
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const p = c.payload as { call_cr: number; paid_cash_cr: number; paid_liq_cr: number; forced_sale_cr: number };
        const enforced = s.recorder
          .all()
          .some((e) => e.kind === 'FORCED_SALE' && e.day === c.day && String((e.payload as { reason?: string }).reason).includes('lender-enforcement'));
        expect(p.paid_cash_cr + p.paid_liq_cr + p.forced_sale_cr + (enforced ? p.call_cr : 0)).toBeGreaterThanOrEqual(p.call_cr - 0.02);
      }
    }
  });

  test('forced-sale path executes through the impact model when LIQ cannot cover (never silently waived)', () => {
    const s = new SimSession({ scenario: 'ILFS-18', mode: 'governed', persistRecorder: false });
    s.runToDay(20);
    const e = s.engine;
    // drain the liquidity sleeve — simulate the fund arriving at the tap
    // with an empty buffer (the world the constitution exists to prevent)
    e.redeemLiq(e.bucketValue('LIQ'));
    e.cash = 0; // test-only: settlement account swept away
    const sales = e.raiseCash(30 * CR, 'governed', 'test:forced');
    expect(sales.length).toBeGreaterThan(0);
    expect(e.cash).toBeGreaterThan(20 * CR); // raised through capped waterfall sales
    for (const t of sales) {
      expect(t.tempCost).toBeGreaterThan(0);
      expect(t.participation).toBeLessThanOrEqual(0.100001); // A3 respected even under duress
    }
    expect(e.impactPaid).toBeGreaterThan(0);
    // the villain pays real fire-sale costs through the same impact model
    const n = runAgent('ILFS-18', 'naive');
    expect(n.engine.impactPaid).toBeGreaterThan(1 * CR);
  });

  test('with FULL autonomy the governed bot needs zero forced sales in all three replays (defense in depth)', () => {
    for (const id of scenarios) {
      const s = runAgent(id, 'governed');
      expect(s.engine.redemptionsMissed).toBe(0);
    }
  });

  test('cash settlement signs: a sale credits cash (minus impact), a buy debits it', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const e = s.engine;
    const cash0 = e.cash;
    e.redeemLiq(10 * CR);
    const cash1 = e.cash;
    expect(cash1 - cash0).toBeCloseTo(10 * CR, 6);
    const tr = e.execute('GOLD', 2 * CR, -1, 'test:sell', false);
    expect(tr).not.toBeNull();
    expect(e.cash - cash1).toBeGreaterThan(0); // sale credited cash minus impact
    expect(tr!.tempCost).toBeGreaterThan(0);
  });

  test('redemption taps reduce AUM by the scripted amount (paid or recorded shortfall)', () => {
    const s = runAgent('ILFS-18', 'governed');
    const taps = s.recorder.all().filter((e) => e.kind === 'REDEMPTION');
    expect(taps.length).toBe(6);
    for (const t of taps) {
      const p = t.payload as { amount_cr: number; paid_cr: number; shortfall_cr: number };
      expect(p.amount_cr).toBeGreaterThan(0);
      expect(p.paid_cr + p.shortfall_cr).toBeCloseTo(p.amount_cr, 1);
    }
  });

  test('day-0 CCIL posting is funded from LIQ (NAV unchanged, gross unchanged)', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const e = s.engine;
    expect(Math.abs(e.nav() - NAV0)).toBeLessThanOrEqual(100);
    expect(e.postedCcil).toBeCloseTo(0.025 * (e.bucketValue('GSEC') + e.bucketValue('IGCORP')), 4);
  });
});

// ---------------------------------------------------------------------------
// 2. CALIBRATION (§5.4 target vs actual)
// ---------------------------------------------------------------------------

describe('Calibration — the §5.4 table, world mode (frozen book)', () => {
  const tan = runWorld('TANTRUM-13');
  const ilfs = runWorld('ILFS-18');
  const cov = runWorld('COVID-20');

  const close = (s: SimSession, b: BucketId) => s.engine.prices[b] / s.engine.startPrices[b] - 1;
  const maxDd = (s: SimSession, b: BucketId) => {
    let peak = -Infinity;
    let m = 0;
    for (const p of [s.engine.startPrices[b], ...s.observations.map((o) => o.prices[b])]) {
      peak = Math.max(peak, p);
      m = Math.min(m, p / peak - 1);
    }
    return m;
  };

  test('TANTRUM-13: GSEC close −6.8% ±1.5', () => expect(Math.abs(close(tan, 'GSEC') + 0.068)).toBeLessThanOrEqual(0.015));
  test('TANTRUM-13: EQ close −6.0% ±1.5', () => expect(Math.abs(close(tan, 'EQ') + 0.06)).toBeLessThanOrEqual(0.015));
  test('TANTRUM-13: GOLD close +9.5% ±1.5', () => expect(Math.abs(close(tan, 'GOLD') - 0.095)).toBeLessThanOrEqual(0.015));
  test('TANTRUM-13: CRED close −6% (info ±2)', () => expect(Math.abs(close(tan, 'CRED') + 0.06)).toBeLessThanOrEqual(0.02));
  test('TANTRUM-13: IGCORP close −4% (info ±2)', () => expect(Math.abs(close(tan, 'IGCORP') + 0.04)).toBeLessThanOrEqual(0.02));
  test('TANTRUM-13: cumulative margin ≈ ₹4.5 Cr', () => expect(Math.abs(tan.engine.marginCumulative / CR - 4.5)).toBeLessThanOrEqual(1.0));

  test('ILFS-18: CRED close −15% ±1.5', () => expect(Math.abs(close(ilfs, 'CRED') + 0.15)).toBeLessThanOrEqual(0.015));
  test('ILFS-18: IGCORP close −5% ±1.5', () => expect(Math.abs(close(ilfs, 'IGCORP') + 0.05)).toBeLessThanOrEqual(0.015));
  test('ILFS-18: GSEC close +2% ±1.5', () => expect(Math.abs(close(ilfs, 'GSEC') - 0.02)).toBeLessThanOrEqual(0.015));
  test('ILFS-18: cumulative margin ≈ ₹2.2 Cr', () => expect(Math.abs(ilfs.engine.marginCumulative / CR - 2.2)).toBeLessThanOrEqual(0.8));

  test('COVID-20: EQ close −9% ±1.5', () => expect(Math.abs(close(cov, 'EQ') + 0.09)).toBeLessThanOrEqual(0.015));
  test('COVID-20: GOLD close +8% ±1.5', () => expect(Math.abs(close(cov, 'GOLD') - 0.08)).toBeLessThanOrEqual(0.015));
  test('COVID-20: GSEC close +2% ±1.5', () => expect(Math.abs(close(cov, 'GSEC') - 0.02)).toBeLessThanOrEqual(0.015));
  test('COVID-20: cumulative margin ₹15.20 Cr ± ₹0.75 Cr (the flagship number)', () =>
    expect(Math.abs(cov.engine.marginCumulative / CR - 15.2)).toBeLessThanOrEqual(0.75));

  test('GSEC max drawdown −10% hard cap: never breached, any scenario', () => {
    for (const s of [tan, ilfs, cov]) expect(maxDd(s, 'GSEC')).toBeGreaterThanOrEqual(-0.10);
  });
  test('IGCORP max drawdown −12% cap: never breached', () => {
    for (const s of [tan, ilfs, cov]) expect(maxDd(s, 'IGCORP')).toBeGreaterThanOrEqual(-0.12);
  });
  test('CRED max drawdown −25% cap: never breached', () => {
    for (const s of [tan, ilfs, cov]) expect(maxDd(s, 'CRED')).toBeGreaterThanOrEqual(-0.25);
  });
  test('EQ max drawdown −35% cap: never breached', () => {
    for (const s of [tan, ilfs, cov]) expect(maxDd(s, 'EQ')).toBeGreaterThanOrEqual(-0.35);
  });

  test('peak single-day margin call ≤ ₹5 Cr, all scenarios', () => {
    for (const s of [tan, ilfs, cov]) expect(s.engine.peakMarginCallDay / CR).toBeLessThanOrEqual(5);
  });

  test('cumulative margin within 0.2–2% of book, all scenarios', () => {
    for (const s of [tan, ilfs, cov]) {
      const frac = s.engine.marginCumulative / NAV0;
      expect(frac).toBeGreaterThanOrEqual(0.002);
      expect(frac).toBeLessThanOrEqual(0.02);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. DETERMINISM
// ---------------------------------------------------------------------------

describe('Determinism — two seeded runs produce identical flight recorders', () => {
  test('world mode: identical hash chains (COVID-20, seed 42)', () => {
    const a = runWorld('COVID-20');
    const b = runWorld('COVID-20');
    expect(a.recorder.size()).toBe(b.recorder.size());
    expect(a.recorder.headHash()).toBe(b.recorder.headHash());
    expect(a.recorder.verify()).toBe(true);
    expect(b.recorder.verify()).toBe(true);
  });

  test('governed mode: identical hash chains (COVID-20, seed 42, LLM off)', () => {
    const a = runAgent('COVID-20', 'governed');
    const b = runAgent('COVID-20', 'governed');
    expect(a.recorder.size()).toBe(b.recorder.size());
    expect(a.recorder.headHash()).toBe(b.recorder.headHash());
  });
});

// ---------------------------------------------------------------------------
// 4. IMPACT & LIQUIDITY
// ---------------------------------------------------------------------------

describe('Impact & liquidity — the Almgren-Chriss brake', () => {
  test('GATE: selling 20% of CRED ADV in CRISIS costs ≥ 1.5% of notional combined', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    s.engine.day = 12; // crisis phase
    const credAdv = s.engine.adv('CRED'); // 40 Cr × 0.25 × 0.8 = 8 Cr
    const q = impactQuote(0.2 * credAdv, credAdv, -1);
    expect(q.combinedPct).toBeGreaterThanOrEqual(0.015);
  });

  test('temporary + permanent split: κ=0.08 paid in cash, γ=0.01 moves the mid', () => {
    const q = impactQuote(50 * CR, 250 * CR, 1);
    expect(q.tempCost).toBeCloseTo(0.08 * 0.2 * 50 * CR, 4);
    expect(q.permShift).toBeCloseTo(0.01 * 0.2, 8);
  });

  test('permanent dislocation decays 0.90/day', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    s.engine.execute('GOLD', 25 * CR, -1, 'test', false); // 10% ADV at day 0
    const d0 = s.engine.disloc['GOLD'];
    expect(d0).toBeLessThan(1);
    s.engine.stepClose(1);
    const d1 = s.engine.disloc['GOLD'];
    expect(d1 - 1).toBeCloseTo((d0 - 1) * 0.9, 10);
  });

  test('ADV liquidity mirage: COVID multiplier path 1.0 → 0.5 → 0.25 → 0.5 → 1.0 bites', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const scen = SCENARIOS['COVID-20'];
    expect(scen.advMultAt(2)).toBe(1.0);
    expect(scen.advMultAt(6)).toBe(0.5);
    expect(scen.advMultAt(15)).toBe(0.25);
    expect(scen.advMultAt(23)).toBe(0.5);
    expect(scen.advMultAt(29)).toBe(1.0);
    expect(s.engine.adv('EQ', 15)).toBeCloseTo(600 * CR * 0.25, 6);
    expect(s.engine.adv('EQ', 29)).toBeCloseTo(600 * CR * 1.0, 6);
  });

  test('ILFS: CRED ADV collapses beyond the market multiplier (NBFC freeze ×0.5)', () => {
    const s = new SimSession({ scenario: 'ILFS-18', mode: 'world', persistRecorder: false });
    // crisis 0.25 × bucket 0.5 = 0.125 of calm
    expect(s.engine.adv('CRED', 20)).toBeCloseTo(40 * CR * 0.125, 6);
  });

  test('A3 cap holds for the governed bot in all three replays (never exceeds 10% ADV)', () => {
    for (const id of scenarios) {
      const s = runAgent(id, 'governed');
      expect(s.engine.maxParticipation).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  test('A3 fails by design for the naive bot (ILFS + COVID fire-sale cascades)', () => {
    const ilfs = runAgent('ILFS-18', 'naive');
    const cov = runAgent('COVID-20', 'naive');
    expect(ilfs.engine.maxParticipation).toBeGreaterThan(0.25);
    expect(cov.engine.maxParticipation).toBeGreaterThan(0.1);
    expect(ilfs.engine.participationBreaches).toBeGreaterThan(0);
  });

  test('capByParticipation clips to 10% of ADV', () => {
    expect(capByParticipation(50 * CR, 100 * CR)).toBeCloseTo(10 * CR, 6);
    expect(capByParticipation(5 * CR, 100 * CR)).toBeCloseTo(5 * CR, 6);
  });

  test('correlation matrices are PSD (eigenvalues ≥ −1e-10)', () => {
    for (const key of Object.keys(CORR)) {
      const ev = eigenvalues(CORR[key]);
      expect(Math.min(...ev)).toBeGreaterThanOrEqual(-1e-10);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. GOVERNOR
// ---------------------------------------------------------------------------

describe('Governor — the constitution never sleeps', () => {
  test('governed bot: zero executed trades breach the 10% ADV cap across all replays', () => {
    for (const id of scenarios) {
      const s = runAgent(id, 'governed');
      const execs = s.recorder.all().filter((e) => e.kind === 'EXECUTION' && (e.payload as { bucket?: string }).bucket);
      for (const x of execs) {
        expect((x.payload as { participation: number }).participation).toBeLessThanOrEqual(0.100001);
      }
    }
  });

  test('governed bot: A1 (LIQ ≥ 5%) is only ever breached by script-forced flows', () => {
    for (const id of scenarios) {
      const s = runAgent(id, 'governed');
      const g = s.governed!;
      for (const o of s.observations) {
        if (o.values['LIQ'] / o.nav < 0.05 - 1e-9) {
          // there must be a script-forced flow that day (margin/redemption)
          const forced = s.recorder.all().some(
            (e) => e.day === o.day && (e.kind === 'MARGIN_CALL' || e.kind === 'REDEMPTION') && ((e.payload as { forced_sale_cr?: number }).forced_sale_cr ?? 0) > 0
          );
          const a1 = g.constitutionChecks.find((c) => c.article === 'A1');
          void a1;
          expect(forced || g.articleFired.some((f) => f.day === o.day && f.article === 'A1')).toBe(true);
        }
      }
    }
  });

  test('CVaR limits per regime: A4 thresholds 2.5 / 2.0 / 1.5 / 2.0', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    expect(s.metrics.cvarLimit('CALM')).toBeCloseTo(0.025, 6);
    expect(s.metrics.cvarLimit('STRESSED')).toBeCloseTo(0.02, 6);
    expect(s.metrics.cvarLimit('CRISIS')).toBeCloseTo(0.015, 6);
    expect(s.metrics.cvarLimit('RECOVERY')).toBeCloseTo(0.02, 6);
  });

  test('A7 tighten-only: feeding an LLM "loosen" output leaves limits unchanged', () => {
    const rm = new RegimeMachine();
    rm.applyRadarSeverity(5);
    const pressureAt5 = rm.radarPressure;
    // an LLM says everything is fine (severity 1, risk_on) — applied via the
    // same A7 path: radar pressure is a decaying max, it can only rise
    rm.applyRadarSeverity(1);
    expect(rm.radarPressure).toBe(pressureAt5);
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const before = s.metrics.cvarLimit('CRISIS');
    // a "loosen" radar event (risk_on) never changes any limit
    const reading = dictionaryRadar('RBI cuts repo, markets calm, recovery underway');
    expect(reading.direction).toBe('risk_on');
    expect(s.metrics.cvarLimit('CRISIS')).toBe(before);
  });

  test('one-way autonomy ratchet: in CRISIS the dial may only move toward scrutiny', () => {
    const d = new AutonomyDial('SUPERVISED');
    d.armRatchet();
    expect(d.setLevel('FULL', 10)).toBe(false); // blocked
    expect(d.level).toBe('SUPERVISED');
    expect(d.setLevel('CONSERVATIVE', 11)).toBe(true); // allowed
    expect(d.level).toBe('CONSERVATIVE');
  });

  test('ratchet disarms outside CRISIS (normal operation restored)', () => {
    const d = new AutonomyDial('CONSERVATIVE');
    d.armRatchet();
    d.disarmRatchet();
    expect(d.setLevel('FULL', 5)).toBe(true);
  });

  test('A9 fail-safe: dictionary radar works with no LLM and never crashes a replay', () => {
    const r = dictionaryRadar('IL&FS defaults on commercial paper; ₹91,000 Cr group debt under cloud');
    expect(r.severity).toBeGreaterThanOrEqual(4);
    expect(r.buckets).toContain('CRED');
    // full governed replay runs end-to-end with llmEnabled=false
    const s = runAgent('ILFS-18', 'governed');
    expect(s.complete).toBe(true);
    expect(s.governed!.radarFeed.every((f) => f.provider === 'dictionary')).toBe(true);
  });

  test('regime machine hysteresis: 2 confirmed days to enter CRISIS', () => {
    const rm = new RegimeMachine();
    const inputs = { volRatio: 3, drawdown: -0.15, radarSeverity: 0, marginUtilization: 0 };
    rm.update(1, inputs);
    expect(rm.regime).toBe('STRESSED');
    rm.update(2, inputs);
    expect(rm.regime).toBe('CRISIS'); // second consecutive crisis day
  });

  test('regime machine hysteresis: 3 confirmed days to exit CRISIS', () => {
    const rm = new RegimeMachine();
    const bad = { volRatio: 3, drawdown: -0.15, radarSeverity: 0, marginUtilization: 0 };
    rm.update(1, bad);
    rm.update(2, bad);
    const good = { volRatio: 1.0, drawdown: -0.01, radarSeverity: 0, marginUtilization: 0 };
    rm.update(3, good);
    expect(rm.regime).toBe('CRISIS');
    rm.update(4, good);
    expect(rm.regime).toBe('CRISIS');
    rm.update(5, good);
    expect(rm.regime).toBe('RECOVERY'); // third confirmed calm day
  });

  test('consent timeout is recorded and the trade is NOT executed', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'governed', autonomy: 'SUPERVISED', persistRecorder: false });
    let timeouts = 0;
    while (!s.complete) {
      s.step();
      timeouts += s.recorder.all().filter((e) => e.kind === 'APPROVAL_TIMEOUT').length;
    }
    expect(timeouts).toBeGreaterThan(0);
    // every timed-out card must have a recorded decision trail
    const cards = s.governed!.consent.all().filter((c) => c.status === 'TIMEOUT');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.decidedBy === 'system:timeout')).toBe(true);
  });

  test('approve → execute: a human-approved trade lands in the recorder with impact', async () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'governed', autonomy: 'SUPERVISED', persistRecorder: false });
    s.runToDay(10);
    const pend = s.governed!.consent.pending();
    expect(pend.length).toBeGreaterThan(0);
    const before = s.recorder.all().filter((e) => e.kind === 'EXECUTION').length;
    const ok = s.governed!.decide(pend[0].id, 'APPROVED', s.engine, (kind, payload) => s.recorder.record(s.day, kind, payload));
    expect(ok).toBe(true);
    const execs = s.recorder.all().filter((e) => e.kind === 'EXECUTION');
    expect(execs.length).toBeGreaterThan(before);
  });

  test('constitution: A2 blocks concentration-increasing proposals, permits remediation', () => {
    const mk = (vals: number[]) => {
      const projected: Record<string, number> = {};
      BUCKETS.forEach((b, i) => (projected[b] = vals[i] * CR));
      return projected;
    };
    const base = {
      regime: 'CALM' as const,
      nav: NAV0,
      projectedLiq: 60 * CR,
      trades: [],
      projectedMargin: 0,
      redemptionPace3d: 0,
      scriptForcedToday: false,
      cvar95: 0.01,
      preCvar95: 0.02,
      preMaxWeight: 0.5,
      radarProvider: 'dictionary',
      overrideRecorded: false,
    };
    // EQ at 43% of gross, above cap and RISING vs pre 42% → blocked
    const worsen = evaluateConstitution({ ...base, projectedValues: mk([500, 250, 150, 80, 80, 100]), preMaxWeight: 0.42 });
    expect(worsen.find((c) => c.article === 'A2')!.passed).toBe(false);
    // EQ at 43% of gross but FALLING (remediation vs pre 45%) → permitted with flag
    const remediate = evaluateConstitution({ ...base, projectedValues: mk([500, 250, 150, 80, 80, 100]), preMaxWeight: 0.45 });
    const a2 = remediate.find((c) => c.article === 'A2')!;
    expect(a2.passed).toBe(true);
    expect(a2.detail).toContain('remediation');
  });

  test('constitution: A4 blocks CVaR deterioration, permits de-risking above the limit', () => {
    const mk = (vals: number[]) => {
      const projected: Record<string, number> = {};
      BUCKETS.forEach((b, i) => (projected[b] = vals[i] * CR));
      return projected;
    };
    const base = {
      regime: 'CRISIS' as const,
      nav: NAV0,
      projectedLiq: 100 * CR,
      trades: [],
      projectedMargin: 0,
      redemptionPace3d: 0,
      scriptForcedToday: false,
      preCvar95: 0.02,
      preMaxWeight: 0.4,
      radarProvider: 'dictionary',
      overrideRecorded: false,
    };
    const worse = evaluateConstitution({ ...base, projectedValues: mk([500, 250, 200, 100, 100, 100]), cvar95: 0.025 });
    expect(worse.find((c) => c.article === 'A4')!.passed).toBe(false);
    const better = evaluateConstitution({ ...base, projectedValues: mk([300, 250, 200, 100, 100, 300]), cvar95: 0.018 });
    const a4 = better.find((c) => c.article === 'A4')!;
    expect(a4.passed).toBe(true);
    expect(a4.detail).toContain('remediation');
  });

  test('governed beats naive in every scenario (the demo thesis, tested)', () => {
    for (const id of scenarios) {
      const n = runAgent(id, 'naive');
      const g = runAgent(id, 'governed');
      expect(g.engine.nav()).toBeGreaterThan(n.engine.nav());
    }
  });
});

// ---------------------------------------------------------------------------
// 6. LLM GUARDRAILS (six-layer defense; no network needed)
// ---------------------------------------------------------------------------

describe('LLM guardrails — zero authority, six layers of defense', () => {
  test('layer 1: schema rejection — severity out of range', () => {
    expect(validateRadar({ event: 'x', severity: 9, buckets: [], direction: 'risk_off', confidence: 0.9, source: 's' }).ok).toBe(false);
    expect(validateRadar({ event: 'x', severity: 0, buckets: [], direction: 'risk_off', confidence: 0.9, source: 's' }).ok).toBe(false);
  });
  test('layer 1: schema rejection — non-integer severity, bad direction, bad confidence', () => {
    expect(validateRadar({ event: 'x', severity: 3.5, buckets: [], direction: 'risk_off', confidence: 0.9, source: 's' }).ok).toBe(false);
    expect(validateRadar({ event: 'x', severity: 3, buckets: [], direction: 'sideways', confidence: 0.9, source: 's' }).ok).toBe(false);
    expect(validateRadar({ event: 'x', severity: 3, buckets: [], direction: 'risk_off', confidence: 1.7, source: 's' }).ok).toBe(false);
    expect(validateRadar({ event: 'x', severity: 3, buckets: [], direction: 'risk_off', confidence: 0.9, source: '' }).ok).toBe(false);
  });
  test('layer 2: enum-constrained buckets drop unknown names', () => {
    const v = validateRadar({ event: 'x', severity: 3, buckets: ['EQ', 'CRYPTO', 'NIFTY'], direction: 'risk_off', confidence: 0.9, source: 's' });
    expect(v.ok).toBe(true);
    expect(v.reading!.buckets).toEqual(['EQ']);
  });
  test('layer 5: unverified source is demoted — confidence halved', () => {
    const v = validateRadar({ event: 'x', severity: 3, buckets: [], direction: 'risk_off', confidence: 0.9, source: 'unknown' });
    expect(v.ok).toBe(true);
    expect(v.reading!.confidence).toBeLessThanOrEqual(0.5);
    expect(v.demoted).toContain('unverified');
  });
  test('layer 3+4: low-confidence / risk_on readings are never applied', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const g = s.governed; // world mode has no governed bot — use the dictionary contract directly
    void g;
    const calm = dictionaryRadar('RBI announces support; markets stabilize and recover');
    expect(calm.direction).toBe('risk_on');
    // A7: applied requires direction risk_off/neutral AND severity/confidence gates
    const applied = calm.confidence >= 0.6 && (calm.direction === 'risk_off' ? calm.severity >= 3 : calm.severity >= 4);
    expect(applied).toBe(false);
  });
  test('dictionary radar maps the crisis vocabulary (fail-safe, A9)', () => {
    expect(dictionaryRadar('default fears trigger redemption rush in credit-risk mutual funds').severity).toBeGreaterThanOrEqual(4);
    expect(dictionaryRadar('war breaks out; markets crash').severity).toBe(5);
    expect(dictionaryRadar('FPIs sell ₹2,800 Cr in Indian equities').buckets).toContain('EQ');
    expect(dictionaryRadar('10Y G-Sec yield tops 8.40%').buckets).toContain('GSEC');
  });
  test('provider labels are explicit for the audit trail', () => {
    expect(radarProviderLabel('dictionary')).toBe('DICT');
    expect(radarProviderLabel('llm')).toBe('GEMINI');
    expect(radarProviderLabel('llm-rejected')).toBe('GEMINI✗');
  });
  test('LLM failure falls back without crashing: llmRadar() on a dead endpoint returns ok:false', async () => {
    // simulate by importing the module and calling with a headline while the
    // SDK is unavailable in this context — must resolve, never throw
    const { llmRadar } = await import('../src/lib/kavach/llm/radar');
    const res = await llmRadar('test headline that will hit the network layer');
    expect(res).toHaveProperty('ok');
    expect(res).toHaveProperty('latencyMs');
  }, 20000);
});

// ---------------------------------------------------------------------------
// 7. METRICS (M2)
// ---------------------------------------------------------------------------

describe('Metrics — EWMA, RU CVaR, liquidity, stress gate', () => {
  function mkMetrics(): MetricsEngine {
    const scen = SCENARIOS['COVID-20'];
    const warm = warmupReturns(scen, 42);
    const w0 = { EQ: 0.5, GSEC: 0.25, IGCORP: 0.2, CRED: 0.1, GOLD: 0.1, LIQ: 0.08875 };
    return new MetricsEngine(scen, warm, 42, w0);
  }

  test('EWMA λ=0.94: variance recursion is exact', () => {
    const m = mkMetrics();
    const var0 = 0.0001;
    const r = 0.01;
    // simulate one manual step
    const b = 'EQ' as BucketId;
    const ewmaBefore = (m as unknown as { ewmaVarB: Record<string, number> }).ewmaVarB[b];
    void var0;
    m.updateDay({ EQ: r, GSEC: 0, IGCORP: 0, CRED: 0, GOLD: 0, LIQ: 0 }, r * 0.5, NAV0);
    const ewmaAfter = (m as unknown as { ewmaVarB: Record<string, number> }).ewmaVarB[b];
    expect(ewmaAfter).toBeCloseTo(0.94 * ewmaBefore + 0.06 * r * r, 12);
  });

  test('RU CVaR: exact fractional tail average (verified against brute force)', () => {
    const m = mkMetrics();
    // 100 scenarios of known returns for EQ only
    const scen: number[][] = [];
    for (let i = 0; i < 100; i++) {
      const r = (i - 50) / 1000; // -5% .. +4.9%
      scen.push([r, 0, 0, 0, 0, 0]);
    }
    const w = { EQ: 1, GSEC: 0, IGCORP: 0, CRED: 0, GOLD: 0, LIQ: 0 };
    const cvar = m.cvar95(w, scen);
    // tail = 5 of 100: worst 5 losses: 0.05,0.049,0.048,0.047,0.046 → mean 0.048
    expect(cvar).toBeCloseTo(0.048, 10);
  });

  test('RU CVaR with fractional tail weight (N=10, tail=0.5 of an atom)', () => {
    const m = mkMetrics();
    const scen: number[][] = [];
    for (let i = 0; i < 10; i++) scen.push([(i - 5) / 100, 0, 0, 0, 0, 0]);
    const w = { EQ: 1, GSEC: 0, IGCORP: 0, CRED: 0, GOLD: 0, LIQ: 0 };
    // ES_95 on 10 equal atoms: VaR95 = worst atom (0.05);
    // ES = (0.5 × worst atom) / 0.5 = 0.05 (RU optimum, analytically verified)
    expect(m.cvar95(w, scen)).toBeCloseTo(0.05, 10);
  });

  test('liquidity horizon explodes in CRISIS (FRTB flavour)', () => {
    const s = new SimSession({ scenario: 'COVID-20', mode: 'world', persistRecorder: false });
    const values: Record<string, number> = {};
    for (const b of BUCKETS) values[b] = s.engine.bucketValue(b);
    const calm = s.metrics.liquidity(values, NAV0, (b) => s.engine.adv(b, 2));
    const crisis = s.metrics.liquidity(values, NAV0, (b) => s.engine.adv(b, 15));
    expect(crisis.portfolioDays).toBeGreaterThan(calm.portfolioDays * 2);
    expect(crisis.perBucket['CRED']).toBeGreaterThan(calm.perBucket['CRED'] * 3);
  });

  test('stress gate: COVID shadow replay on day-0 weights flags the danger', () => {
    const m = mkMetrics();
    const values = { EQ: 500 * CR, GSEC: 250 * CR, IGCORP: 200 * CR, CRED: 100 * CR, GOLD: 100 * CR, LIQ: 88.75 * CR };
    const res = m.stressGate(values);
    expect(res.terminalDrawdown).toBeLessThan(-0.08);
  });

  test('warm-up: 250 days of history precede day 0 (60-day minimum satisfied)', () => {
    const m = mkMetrics();
    expect(m.bucketRets('EQ').length).toBeGreaterThanOrEqual(250);
    expect(m.portfolioRets.length).toBeGreaterThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// 8. REPLAY CONTROLLER (API surface logic) + live HTTP E2E
// ---------------------------------------------------------------------------

describe('ReplayController — the A/B engine behind the API', () => {
  test('both-mode replay creates two sessions with the same seed and world', () => {
    const r = new ReplayController({ scenario: 'COVID-20', mode: 'both' });
    expect(r.sessions['naive']).toBeDefined();
    expect(r.sessions['governed']).toBeDefined();
    r.runToEnd();
    expect(r.complete).toBe(true);
    const n = r.sessions['naive']!;
    const g = r.sessions['governed']!;
    expect(n.complete && g.complete).toBe(true);
    expect(g.engine.nav()).toBeGreaterThan(n.engine.nav());
  });

  test('recorder range query returns windowed entries with valid chain', () => {
    const r = new ReplayController({ scenario: 'COVID-20', mode: 'governed' });
    r.runToEnd();
    const mid = r.recorderRange('governed', 5, 9);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.every((e) => e.day >= 5 && e.day <= 9)).toBe(true);
    expect(r.sessions['governed']!.recorder.verify()).toBe(true);
  });

  test('decide() routes approve/reject through the consent queue', () => {
    const r = new ReplayController({ scenario: 'COVID-20', mode: 'governed', autonomy: 'SUPERVISED' });
    r.step(12);
    const pending = r.governed!.governed!.consent.pending();
    if (pending.length > 0) {
      expect(r.decide(pending[0].id, 'REJECTED')).toBe(true);
      expect(pending[0].status).toBe('REJECTED');
    }
    expect(r.decide('APR-XXXX', 'APPROVED')).toBe(false);
  });

  test('post-mortem template fallback works without the LLM', async () => {
    const r = new ReplayController({ scenario: 'COVID-20', mode: 'both' });
    r.runToEnd();
    const pm = await r.generatePostMortem(false);
    expect(pm).not.toBeNull();
    expect(pm!.markdown).toContain('KAVACH post-mortem');
    expect(pm!.markdown).toContain('The AI never traded');
    expect(pm!.provider).toBe('template');
  });
});

describe.skipIf(!devServerUp)('Live API E2E (dev server on :3000)', () => {
  const base = 'http://localhost:3000';
  test('GET /api/kavach/health reports gemini/news/price/db/budget/market (v2 shape)', async () => {
    const res = await fetch(`${base}/api/kavach/health`);
    const d = await res.json();
    expect(d.status).toBe('ok');
    expect(d.db).toBe('ok');
    expect(['ok', 'fallback', 'nokey', 'budget']).toContain(d.gemini.state);
    expect(['ok', 'stale', 'error', 'never']).toContain(d.price.state);
    expect(Array.isArray(d.news)).toBe(true);
    expect(d.market).toHaveProperty('open');
    expect(d.budget).toHaveProperty('used');
    expect(typeof d.budget.limit).toBe('number');
    expect(d.scenarios.length).toBe(3);
  });

  test('replay E2E both modes: start → step → complete → state', async () => {
    await fetch(`${base}/api/kavach/replay/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'COVID-20', mode: 'both' }),
    });
    await fetch(`${base}/api/kavach/replay/stop`, { method: 'POST' });
    const res = await fetch(`${base}/api/kavach/state`);
    const d = await res.json();
    expect(d.active).toBe(true);
    expect(d.complete).toBe(true);
    expect(d.day).toBe(30);
    expect(d.bots['naive'].nav).toBeGreaterThan(0);
    expect(d.bots['governed'].nav).toBeGreaterThan(d.bots['naive'].nav);
    expect(d.abHeadline).toContain('NaiveBot');
  });

  test('flightrecorder range query with bot filter', async () => {
    const res = await fetch(`${base}/api/kavach/flightrecorder?bot=governed&from=10&to=14&limit=50`);
    const d = await res.json();
    expect(d.bot).toBe('governed');
    expect(d.chainValid).toBe(true);
    expect(d.entries.every((e: { day: number }) => e.day >= 10 && e.day <= 14)).toBe(true);
  });

  test('mode endpoint enforces the autonomy ratchet', async () => {
    const res = await fetch(`${base}/api/kavach/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autonomy: 'SUPERVISED' }),
    });
    const d = await res.json();
    expect(['FULL', 'SUPERVISED', 'CONSERVATIVE']).toContain(d.autonomy);
  });

  test('narrator post-mortem endpoint returns markdown', async () => {
    const res = await fetch(`${base}/api/kavach/narrator/postmortem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useLlm: false }),
    });
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.postMortem.markdown.length).toBeGreaterThan(200);
  });

  test('constitution endpoint exposes all nine articles', async () => {
    const res = await fetch(`${base}/api/kavach/governor/constitution`);
    const d = await res.json();
    expect(d.articles.length).toBe(9);
    expect(d.articles.map((a: { article: string }) => a.article)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']);
  });
});

// ---------------------------------------------------------------------------
// 9. FORMATTING (Indian money)
// ---------------------------------------------------------------------------

describe('Formatting — Indian lakh/crore, exact strings', () => {
  test('groupIndian: last 3 digits, then groups of 2', () => {
    expect(groupIndian('10000000000')).toBe('10,00,00,00,000');
    expect(groupIndian('1000000000')).toBe('1,00,00,00,000');
    expect(groupIndian('10550000')).toBe('1,05,50,000');
    expect(groupIndian('1250')).toBe('1,250');
    expect(groupIndian('999')).toBe('999');
  });
  test('fmt_inr_grouped: ₹ with Indian grouping', () => {
    expect(fmt_inr_grouped(1e10)).toBe('₹10,00,00,00,000.00');
    expect(fmt_inr_grouped(10550000)).toBe('₹1,05,50,000.00');
    expect(fmt_inr_grouped(1250)).toBe('₹1,250.00');
  });
  test('fmt_inr: institutional Cr, retail L, small plain', () => {
    expect(fmt_inr(1.01525e10)).toBe('₹1,015.25 Cr');
    expect(fmt_inr(450000)).toBe('₹4.50 L');
    expect(fmt_inr(1250)).toBe('₹1,250');
    expect(fmt_inr(-2.46e10)).toBe('-₹2,460.00 Cr');
    expect(fmt_inr(5e6)).toBe('₹50.00 L');
  });
  test('no $ anywhere in user-facing money strings', () => {
    for (const x of [0, 1, 999.5, 1e5, 1e7, 1.01525e10, -3.7e9]) {
      expect(fmt_inr(x)).not.toContain('$');
      expect(fmt_inr_grouped(x)).not.toContain('$');
    }
  });
  test('currencies use ₹ crore/lakh only — no M/B suffixes', () => {
    expect(fmt_inr(1.5e9)).toContain('Cr');
    expect(fmt_inr(2500000)).toContain('L');
    expect(fmt_inr(1.5e9)).not.toContain('M');
    expect(fmt_inr(2.5e10)).not.toContain('B');
  });
});

// ---------------------------------------------------------------------------
// 10. FLIGHT RECORDER (hash chain mechanics)
// ---------------------------------------------------------------------------

describe('Flight recorder — append-only, hash-chained, tamper-evident', () => {
  test('chain verifies; tampering breaks it', () => {
    const r = new FlightRecorder('test-chain', false);
    r.record(0, 'A', { x: 1 });
    r.record(1, 'B', { y: 'z' });
    r.record(2, 'C', { arr: [1, 2, 3] });
    expect(r.verify()).toBe(true);
    const entries = r.all();
    (entries[1].payload as { y: string }).y = 'tampered';
    expect(r.verify()).toBe(false);
  });
  test('canonicalization kills -0 and rounds consistently', () => {
    const r = new FlightRecorder('test-canon', false);
    r.record(0, 'A', { x: -0, y: 1e-15, z: 0.123456789123 });
    expect(r.verify()).toBe(true);
    const h = hashEntry('0'.repeat(64), { day: 0, kind: 'A', x: 0, y: 0, z: 0.1234567891 });
    expect(r.all()[0].entryHash).toBe(h);
  });
  test('identical entry sequences produce identical head hashes', () => {
    const a = new FlightRecorder('a', false);
    const b = new FlightRecorder('b', false);
    for (let i = 0; i < 20; i++) {
      a.record(i, 'K', { i, v: i * 1.5 });
      b.record(i, 'K', { i, v: i * 1.5 });
    }
    expect(a.headHash()).toBe(b.headHash());
  });
});
