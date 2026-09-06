/** KAVACH — LIVE smoke (dev tool, not shipped as a test): fixture prices+news, no key, no network. */
import { LiveSession } from '../src/lib/kavach/live/liveSession';
import { CR } from '../src/lib/kavach/constants';

const REAL = { eq: 24800, usdinr: 86.4, goldUsd: 2650, asOf: new Date().toISOString(), stale: false };
const NEWS = {
  articles: [
    { title: 'FPIs sell ₹3,400 Cr in Indian equities as global yields spike', url: 'https://example.com/1', source: 'Economic Times', provider: 'googlenews' },
    { title: 'NBFC funding stress deepens; spreads widen 60bp', url: 'https://example.com/2', source: 'Mint', provider: 'gdelt' },
    { title: 'RBI signals policy support; OMOs on the table', url: 'https://example.com/3', source: 'BS', provider: 'googlenews' },
  ],
  fetchedAt: Date.now(),
  degraded: false,
  fresh: 3,
  statuses: [],
};

async function main() {
  const deps = {
    priceFn: async () => REAL,
    newsFn: async () => NEWS,
    allowClosedMarket: true,
  };
  const s = await LiveSession.create({ deps });
  console.log('day-0 NAV Cr:', +(s.book.nav() / CR).toFixed(4));
  console.log('day-0 ledger residual:', s.book.ledgerResidual());

  const closed = await s.rebalance(false); // market closed on weekend → must refuse
  console.log('closed-market rebalance:', closed);

  const r1 = await s.rebalance(true); // forced
  console.log('forced rebalance:', r1);
  console.log('regime:', s.bot.regimeMachine.regime, '| autonomy:', s.bot.autonomy.level);
  console.log('radar events:', s.radarLog.map((l) => `${l.reading.severity}:${l.reading.event}${l.applied ? '✓' : l.rejectedByA7 ? '✗A7' : '·'}`));
  console.log('advisor outcome (no key):', s.lastAdvisorOutcome, '| critic:', s.lastCriticOutcome);
  const st = s.state();
  console.log('post-rebalance NAV Cr:', +(st.nav / CR).toFixed(4), '| gross Cr:', +(st.book.gross / CR).toFixed(2));
  console.log('constitution:', st.constitution.filter((c) => !c.passed).map((c) => c.article));
  console.log('recorder entries:', st.recorder.entries, 'chain valid:', st.recorder.chainValid);
  console.log('approvals pending:', st.approvals.filter((a) => a.status === 'PENDING').length);

  // day 2: prices move down 4% EQ → regime + margin reaction
  REAL.eq = 24800 * 0.96;
  await s.rebalance(true);
  console.log('day', s.day, 'NAV Cr:', +(s.book.nav() / CR).toFixed(4), 'regime:', s.bot.regimeMachine.regime);
  console.log('entries:', s.recorder.size(), 'valid:', s.recorder.verify());

  // resume test
  const resumed = await LiveSession.resumeLatest(deps);
  console.log('resumed day:', resumed?.day, 'entries after resume:', resumed?.recorder.size(), 'chain valid:', resumed?.recorder.verify());
  await resumed?.stop();
  process.exit(0);
}
main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
