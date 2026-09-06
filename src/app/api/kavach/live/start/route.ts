import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive, setLive, store } from '@/lib/kavach/store';
import { LiveSession } from '@/lib/kavach/live/liveSession';
import { parseBody, rateLimit } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

const Body = z.object({
  fresh: z.boolean().optional(),
  autonomy: z.enum(['FULL', 'SUPERVISED', 'CONSERVATIVE']).optional(),
  seed: z.number().int().optional(),
});

/**
 * POST /api/kavach/live/start — create (or resume) the LIVE PAPER session.
 * {fresh: true} stops the current one and starts a new ₹1,000 Cr book.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.res;
  if (parsed.data.fresh && store.live) {
    await store.live.stop();
  }
  if (parsed.data.fresh || !store.live) {
    setLive(null);
    const s = await LiveSession.create({ autonomy: parsed.data.autonomy, seed: parsed.data.seed });
    setLive(s);
  }
  const s = store.live ?? (await getLive());
  if (!s) return NextResponse.json({ error: 'live session unavailable' }, { status: 500 });
  return NextResponse.json({
    ok: true,
    sessionId: s.id,
    day: s.day,
    mode: 'LIVE PAPER',
    disclaimer:
      'Educational paper simulation on real market data. Never places real orders. Not investment advice.',
  });
}

/** DELETE /api/kavach/live/start — stop the live session (recorded, resumable-later no; state persists). */
export async function DELETE() {
  if (store.live) await store.live.stop();
  return NextResponse.json({ ok: true });
}
