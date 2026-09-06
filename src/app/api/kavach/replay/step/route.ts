import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  let days = 1;
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const raw = Number.isFinite(Number(b?.days)) ? Number(b.days) : Number(b?.n);
    if (Number.isFinite(raw)) days = Math.max(1, Math.min(999, raw));
  } catch {
    /* default 1 */
  }
  if (r.complete) return NextResponse.json({ ok: true, day: r.day, complete: true, advanced: 0 });
  const before = r.day;
  r.step(days);
  return NextResponse.json({ ok: true, day: r.day, complete: r.complete, advanced: r.day - before });
}
