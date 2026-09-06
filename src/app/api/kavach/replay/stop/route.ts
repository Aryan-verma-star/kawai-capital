import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function POST() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  r.runToEnd();
  return NextResponse.json({ ok: true, day: r.day, complete: true });
}
