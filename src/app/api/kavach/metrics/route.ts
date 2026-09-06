import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const out: Record<string, unknown> = {};
  for (const [mode, s] of Object.entries(r.sessions)) {
    const snap = s!.snapshot();
    out[mode] = {
      day: snap.day,
      ewmaPortfolioVolAnn: snap.ewmaPortfolioVolAnn,
      volRatio: snap.volRatio,
      cvar95: snap.cvar95,
      cvarLimit: snap.cvarLimit,
      drawdown: snap.drawdown,
      maxDrawdown: snap.maxDrawdown,
      liquidityDays: snap.liquidityDays,
      liquidityPerBucket: snap.liquidityPerBucket,
      bucketEwmaVols: Object.fromEntries(snap.bucketStats.map((b) => [b.bucket, b.ewmaVol])),
      marginCumulative: snap.marginCumulative,
      impactPaid: snap.impactPaid,
      maxParticipation: snap.maxParticipation,
    };
  }
  return NextResponse.json({ scenario: r.scenario, day: r.day, metrics: out });
}
