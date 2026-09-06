import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { enrichState } from '@/lib/kavach/live/liveSession';
import { parseBody, rateLimit } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

const Body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) });

/**
 * POST /api/kavach/live/approve/[id] — answer a durable consent card.
 * Cards survive restarts; approved trades are re-clipped to A3 at execution
 * time and recorded with counterfactual provenance.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const { id } = await ctx.params;
  if (!id || !/^APR-\d{3,6}$/.test(id)) {
    return NextResponse.json({ error: 'invalid approval id' }, { status: 400 });
  }
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.res;
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  const ok = await s.decide(id, parsed.data.decision);
  if (!ok) return NextResponse.json({ error: `approval ${id} not found or already decided` }, { status: 409 });
  const st = await enrichState(s.state());
  return NextResponse.json({ ok: true, decided: parsed.data.decision, live: st });
}
