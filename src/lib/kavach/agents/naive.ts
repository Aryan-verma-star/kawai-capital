/**
 * KAVACH — NaiveBot (M3, the villain — deliberately realistic).
 *
 * A vol-targeting rebalancer: the strategy that sounds fine in a pitch deck and
 * killed people in 1987, 2018 and 2020. Daily: compute realized vol, rebalance
 * to hold portfolio vol at a 12% annualized target, sell whatever is over-weight
 * after falls, buy whatever rose. NO ADV awareness, NO participation cap,
 * NO stress test, NO consent. Procyclical by construction — exactly the failure
 * mode the ECB Financial Stability Review (2020) documents.
 */

import { BOOK, BUCKETS, BucketId } from '../constants';
import { MetricsEngine } from '../metrics/metrics';
import { Regime } from '../types';
import { WorldEngine } from '../world/engine';

const VOL_TARGET = 0.12; // annualized
const ADJUST_SPEED = 0.5; // fraction of gap closed per day — fast enough to be procyclical
const ANN = Math.sqrt(250);

/** Day-0 risk-bucket proportions (the fixed rebalancing target). */
const RISK_W0: Record<BucketId, number> = (() => {
  const risk = BOOK.filter((b) => b.id !== 'LIQ');
  const tot = risk.reduce((a, b) => a + b.grossCr, 0);
  const out = {} as Record<BucketId, number>;
  for (const b of risk) out[b.id] = b.grossCr / tot;
  out['LIQ'] = 0;
  return out;
})();

export class NaiveBot {
  readonly id = 'naive' as const;
  cascadeDays = 0; // days with any bucket participation > 25% ADV
  tradesToday: { bucket: BucketId; value: number; participation: number }[] = [];

  act(
    engine: WorldEngine,
    metrics: MetricsEngine,
    day: number,
    record: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    this.tradesToday = [];
    const nav = engine.nav();
    if (nav <= 0) return;

    const vol = Math.max(metrics.ewmaPortfolioVol() * ANN, 0.02);
    // FULL vol-target scaling: when realized vol explodes, the target risk
    // budget collapses and the bot must dump risk exactly when liquidity is
    // worst — procyclical by construction (ECB FSR 2020).
    const scale = Math.min(1, VOL_TARGET / vol);
    const riskValue = BUCKETS.filter((b) => b !== 'LIQ').reduce((a, b) => a + engine.bucketValue(b), 0);
    const desiredRisk = riskValue * scale;

    const desired: Record<BucketId, number> = {} as Record<BucketId, number>;
    for (const b of BUCKETS) {
      if (b === 'LIQ') continue;
      // vol-target gross + rebalancing back to day-0 weights (buys the dip in CRED)
      desired[b] = RISK_W0[b] * desiredRisk;
    }

    const trades: { bucket: BucketId; value: number; direction: 1 | -1 }[] = [];
    for (const b of BUCKETS) {
      if (b === 'LIQ') continue;
      const gap = ADJUST_SPEED * (desired[b] - engine.bucketValue(b));
      if (Math.abs(gap) < 5e5) continue; // ignore < ₹5 L
      trades.push({ bucket: b, value: Math.abs(gap), direction: gap > 0 ? 1 : -1 });
    }

    // sells first (raise cash), then buys bounded by cash — no ADV awareness at all
    let worstPart = 0;
    for (const t of trades.filter((x) => x.direction === -1).sort((a, b) => b.value - a.value)) {
      const tr = engine.execute(t.bucket, t.value, -1, `naive:vol-target`);
      if (tr) {
        worstPart = Math.max(worstPart, tr.participation);
        this.tradesToday.push({ bucket: tr.bucket, value: tr.value, participation: tr.participation });
      }
    }
    const buys = trades.filter((x) => x.direction === 1);
    const cashAvail = engine.cash + Math.max(0, engine.bucketValue('LIQ')); // will spend LIQ too
    let budget = cashAvail;
    for (const t of buys) {
      const spend = Math.min(t.value, budget);
      if (spend < 5e5) continue;
      if (engine.cash < spend) engine.redeemLiq(spend - engine.cash);
      const tr = engine.execute(t.bucket, spend, 1, `naive:rebalance`);
      if (tr) {
        budget -= tr.value + 0; // cash already debited by execute
        worstPart = Math.max(worstPart, tr.participation);
        this.tradesToday.push({ bucket: tr.bucket, value: tr.value, participation: tr.participation });
      }
    }
    if (worstPart > 0.25) this.cascadeDays++;
    if (this.tradesToday.length > 0) {
      record('NAIVE_TRADES', {
        day,
        vol_annualized: vol,
        scale,
        trades: this.tradesToday.map((t) => ({
          bucket: t.bucket,
          value_cr: +(t.value / 1e7).toFixed(3),
          participation_pct: +(t.participation * 100).toFixed(1),
        })),
      });
    }
  }

  regimeOf(): Regime {
    return 'CALM'; // the naive bot has no regime awareness — that's the point
  }
}
