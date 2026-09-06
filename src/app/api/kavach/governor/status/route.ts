import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const g = r.governed;
  if (!g || !g.governed) return NextResponse.json({ error: 'no governed session in this replay' }, { status: 404 });
  const snap = g.snapshot();
  return NextResponse.json({
    scenario: r.scenario,
    day: snap.day,
    regime: snap.regime,
    regimePath: snap.regimePath,
    autonomy: g.governed.autonomy.level,
    ratchetArmed: g.governed.autonomy.isRatchetArmed(),
    ratchetEvents: snap.ratchetEvents,
    radarPressure: g.governed.regimeMachine.radarPressure,
    constitution: snap.constitution,
    articleFired: snap.articleFired,
    approvals: {
      pending: snap.approvals.filter((a) => a.status === 'PENDING'),
      recent: snap.approvals,
    },
  });
}
