import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { enrichState } from '@/lib/kavach/live/liveSession';
import { parseBody, rateLimit } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

const Body = z.object({ force: z.boolean().optional() });

/**
 * POST /api/kavach/live/poll — the 15-minute heartbeat: prices (10-min cache),
 * news + Gemini radar (15-min TTL), day advance if a new IST market date
 * opened. Safe to call as often as the cache allows; never trades.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.res;
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  await s.pollPrices(parsed.data.force);
  await s.refreshRadar(parsed.data.force);
  const advanced = await s.advanceDayIfNeeded();
  const st = await enrichState(s.state());
  return NextResponse.json({ ok: true, advanced, live: st });
}
