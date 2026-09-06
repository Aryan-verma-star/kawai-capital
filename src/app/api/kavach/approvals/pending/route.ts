import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const g = r.governed;
  if (!g) return NextResponse.json({ pending: [] });
  const snap = g.snapshot();
  return NextResponse.json({ pending: snap.approvals.filter((a) => a.status === 'PENDING') });
}
