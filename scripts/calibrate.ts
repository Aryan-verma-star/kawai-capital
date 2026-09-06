/**
 * KAVACH calibration harness — runs every scenario and prints the §5.4
 * calibration table (target vs actual), drawdown caps, margin gates, ledger
 * residuals, and A/B end-of-replay stats. Never relaxes a gate to pass:
 * if a target is out of band it is reported loudly.
 *
 * Run: bun scripts/calibrate.ts
 */

import { SimSession } from '../src/lib/kavach/sim';
import { BUCKETS, BucketId, CR } from '../src/lib/kavach/constants';
import { SCENARIOS } from '../src/lib/kavach/world/scenarios';
import { fmt_inr, fmt_pct } from '../src/lib/kavach/format';

interface Target {
  scenario: string;
  metric: string;
  target: string;
  actual: string;
  pass: boolean;
}

const targets: Target[] = [];

function check(scenario: string, metric: string, target: string, actual: string, pass: boolean) {
  targets.push({ scenario, metric, target, actual, pass });
}

function runWorld(scenarioId: keyof typeof SCENARIOS) {
  const s = new SimSession({ scenario: scenarioId, mode: 'world', persistRecorder: false });
  const scen = SCENARIOS[scenarioId];
  const day0 = s.engine.nav();
  check(scenarioId, 'Day-0 NAV', '₹1,000.00 Cr', `${fmt_inr(day0)}`, Math.abs(day0 - 1000 * CR) <= 100);

  let worstLedger = 0;
  while (!s.complete) {
    s.step();
    worstLedger = Math.max(worstLedger, s.engine.ledgerResidual());
  }
  check(scenarioId, 'Ledger residual (all days)', '≤ 1e-8 rel', `${worstLedger.toExponential(2)} (abs)`, worstLedger <= 1e-8 * 1000 * CR);

  // closes
  const rets: Record<string, number> = {};
  for (const b of BUCKETS) rets[b] = s.engine.prices[b] / s.engine.startPrices[b] - 1;

  // max drawdown per bucket (price path)
  const dd: Record<string, number> = {};
  for (const b of BUCKETS) {
    let peak = -Infinity;
    let m = 0;
    for (const p of [s.engine.startPrices[b], ...s.observations.map((o) => o.prices[b])]) {
      peak = Math.max(peak, p);
      m = Math.min(m, p / peak - 1);
    }
    dd[b] = m;
  }

  const marginCr = s.engine.marginCumulative / CR;
  const peakCallCr = s.engine.peakMarginCallDay / CR;

  return { s, rets, dd, marginCr, peakCallCr };
}

console.log('='.repeat(100));
console.log('KAVACH CALIBRATION HARNESS — world mode (frozen book, pure world engine)');
console.log('='.repeat(100));

const tan = runWorld('TANTRUM-13');
check('TANTRUM-13', 'GSEC close', '−6.8% ±1.5', fmt_pct(tan.rets['GSEC']), Math.abs(tan.rets['GSEC'] - (-0.068)) <= 0.015);
check('TANTRUM-13', 'EQ close', '−6.0% ±1.5', fmt_pct(tan.rets['EQ']), Math.abs(tan.rets['EQ'] - (-0.06)) <= 0.015);
check('TANTRUM-13', 'GOLD close', '+9.5% ±1.5', fmt_pct(tan.rets['GOLD']), Math.abs(tan.rets['GOLD'] - 0.095) <= 0.015);
check('TANTRUM-13', 'CRED close', '−6% (info)', fmt_pct(tan.rets['CRED']), Math.abs(tan.rets['CRED'] - (-0.06)) <= 0.02);
check('TANTRUM-13', 'IGCORP close', '−4% (info)', fmt_pct(tan.rets['IGCORP']), Math.abs(tan.rets['IGCORP'] - (-0.04)) <= 0.02);
check('TANTRUM-13', 'GSEC max DD', '≥ −10% (never breach)', fmt_pct(tan.dd['GSEC']), tan.dd['GSEC'] >= -0.10);
check('TANTRUM-13', 'Cumulative margin', '≈ ₹4.5 Cr', `${tan.marginCr.toFixed(2)} Cr`, Math.abs(tan.marginCr - 4.5) <= 1.0);
check('TANTRUM-13', 'Peak single-day call', '≤ ₹5 Cr', `${tan.peakCallCr.toFixed(2)} Cr`, tan.peakCallCr <= 5);

const ilfs = runWorld('ILFS-18');
check('ILFS-18', 'CRED close', '−15% ±1.5', fmt_pct(ilfs.rets['CRED']), Math.abs(ilfs.rets['CRED'] - (-0.15)) <= 0.015);
check('ILFS-18', 'IGCORP close', '−5% ±1.5', fmt_pct(ilfs.rets['IGCORP']), Math.abs(ilfs.rets['IGCORP'] - (-0.05)) <= 0.015);
check('ILFS-18', 'GSEC close', '+2% ±1.5', fmt_pct(ilfs.rets['GSEC']), Math.abs(ilfs.rets['GSEC'] - 0.02) <= 0.015);
check('ILFS-18', 'CRED max DD', '≥ −25% (never breach)', fmt_pct(ilfs.dd['CRED']), ilfs.dd['CRED'] >= -0.25);
check('ILFS-18', 'IGCORP max DD', '≥ −12% (never breach)', fmt_pct(ilfs.dd['IGCORP']), ilfs.dd['IGCORP'] >= -0.12);
check('ILFS-18', 'Cumulative margin', '≈ ₹2.2 Cr', `${ilfs.marginCr.toFixed(2)} Cr`, Math.abs(ilfs.marginCr - 2.2) <= 0.8);
check('ILFS-18', 'Peak single-day call', '≤ ₹5 Cr', `${ilfs.peakCallCr.toFixed(2)} Cr`, ilfs.peakCallCr <= 5);

const cov = runWorld('COVID-20');
check('COVID-20', 'EQ close', '−9% ±1.5', fmt_pct(cov.rets['EQ']), Math.abs(cov.rets['EQ'] - (-0.09)) <= 0.015);
check('COVID-20', 'GOLD close', '+8% ±1.5', fmt_pct(cov.rets['GOLD']), Math.abs(cov.rets['GOLD'] - 0.08) <= 0.015);
check('COVID-20', 'GSEC close', '+2% ±1.5', fmt_pct(cov.rets['GSEC']), Math.abs(cov.rets['GSEC'] - 0.02) <= 0.015);
check('COVID-20', 'EQ max DD', '≥ −35% (never breach)', fmt_pct(cov.dd['EQ']), cov.dd['EQ'] >= -0.35);
check('COVID-20', 'GSEC max DD', '≥ −10% (never breach)', fmt_pct(cov.dd['GSEC']), cov.dd['GSEC'] >= -0.10);
check('COVID-20', 'Cumulative margin (day 30)', '₹15.20 Cr ± 0.75', `${cov.marginCr.toFixed(2)} Cr`, Math.abs(cov.marginCr - 15.2) <= 0.75);
check('COVID-20', 'Peak single-day call', '≤ ₹5 Cr', `${cov.peakCallCr.toFixed(2)} Cr`, cov.peakCallCr <= 5);
check('COVID-20', 'Margin/book', '0.2–2%', fmt_pct(cov.marginCr / 1000), cov.marginCr / 1000 >= 0.002 && cov.marginCr / 1000 <= 0.02);

console.log('\n--- §5.4 CALIBRATION TABLE (world mode) ---');
for (const t of targets) {
  console.log(`${t.pass ? '✓' : '✗ FAIL'} [${t.scenario}] ${t.metric}: target ${t.target} | actual ${t.actual}`);
}

console.log('\n--- FULL CLOSE/DD DETAIL (world mode) ---');
for (const [name, r] of [['TANTRUM-13', tan], ['ILFS-18', ilfs], ['COVID-20', cov]] as const) {
  console.log(`\n${name}:`);
  for (const b of ['EQ', 'GSEC', 'IGCORP', 'CRED', 'GOLD', 'LIQ'] as BucketId[]) {
    console.log(`  ${b.padEnd(7)} close ${fmt_pct(r.rets[b]).padStart(8)}   maxDD ${fmt_pct(r.dd[b]).padStart(8)}`);
  }
}

console.log('\n--- A/B REPLAY (naive vs governed, seed 42) ---');
for (const scenId of ['TANTRUM-13', 'ILFS-18', 'COVID-20'] as const) {
  const n = new SimSession({ scenario: scenId, mode: 'naive', persistRecorder: false });
  const g = new SimSession({ scenario: scenId, mode: 'governed', persistRecorder: false });
  while (!n.complete) n.step();
  while (!g.complete) g.step();
  const ns = n.snapshot();
  const gs = g.snapshot();
  console.log(`\n${scenId}:`);
  console.log(`  naive    NAV ${fmt_inr(ns.nav)} (ret ${fmt_pct(ns.nav / 1000 / CR - 1)}) impact ${fmt_inr(ns.impactPaid)} maxPart ${(ns.maxParticipation * 100).toFixed(0)}% cascades ${ns.cascadeDays} forcedLegs ${ns.forcedSaleEvents} mdd ${fmt_pct(ns.maxDrawdown)}`);
  console.log(`  governed NAV ${fmt_inr(gs.nav)} (ret ${fmt_pct(gs.nav / 1000 / CR - 1)}) impact ${fmt_inr(gs.impactPaid)} maxPart ${(gs.maxParticipation * 100).toFixed(1)}% forcedLegs ${gs.forcedSaleEvents} mdd ${fmt_pct(gs.maxDrawdown)} regimePath ${[...new Set(gs.regimePath)].join('→')}`);
  console.log(`  governed margin cum ${fmt_inr(gs.marginCumulative)} | redemptions missed: naive ${ns.redemptionsMissed}, governed ${gs.redemptionsMissed}`);
  console.log(`  governed article firings: ${gs.articleFired.length ? gs.articleFired.map((f) => `${f.article}@d${f.day}`).join(', ') : 'none'}`);
}

const fails = targets.filter((t) => !t.pass);
console.log(`\n${'='.repeat(100)}\nWORLD-MODE GATES: ${targets.length - fails.length}/${targets.length} pass${fails.length ? '\nFAILURES:\n' + fails.map((f) => `${f.scenario} ${f.metric}: ${f.actual} vs ${f.target}`).join('\n') : ''}`);
