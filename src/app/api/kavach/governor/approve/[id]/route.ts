import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const { id } = await ctx.params;
  let decision: 'APPROVED' | 'REJECTED' = 'APPROVED';
  try {
    const b = (await req.json()) as Record<string, unknown>;
    if (String(b?.decision).toUpperCase() === 'REJECTED') decision = 'REJECTED';
  } catch {
    /* default approve */
  }
  const ok = r.decide(id, decision);
  if (!ok) return NextResponse.json({ error: `approval ${id} not found or already decided` }, { status: 404 });
  return NextResponse.json({ ok: true, id, decision });
}
