import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const g = r.governed;
  if (!g || !g.governed) return NextResponse.json({ regime: 'CALM', path: [], transitions: [] });
  const snap = g.snapshot();
  return NextResponse.json({
    regime: snap.regime,
    path: snap.regimePath,
    transitions: g.governed.regimeMachine.transitions,
    radarPressure: g.governed.regimeMachine.radarPressure,
    volRatio: snap.volRatio,
    drawdown: snap.drawdown,
    marginUtilization: (g.engine.postedMtf + g.engine.postedCcil) / Math.max(g.engine.nav(), 1),
  });
}
