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
      nav: snap.nav,
      gross: snap.gross,
      cash: snap.cash,
      borrowings: snap.borrowings,
      postedMtf: snap.postedMtf,
      postedCcil: snap.postedCcil,
      bucketStats: snap.bucketStats,
      values: snap.values,
      weights: snap.weights,
      prices: snap.prices,
    };
  }
  return NextResponse.json({ scenario: r.scenario, day: r.day, portfolio: out });
}
