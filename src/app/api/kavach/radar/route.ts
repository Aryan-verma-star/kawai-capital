import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const g = r.governed;
  if (!g) return NextResponse.json({ radar: [], provider: 'none' });
  const snap = g.snapshot();
  return NextResponse.json({
    provider: r.llmRadar ? 'llm+dictionary' : 'dictionary',
    llmEnabled: r.llmRadar,
    radar: snap.radarFeed,
  });
}
