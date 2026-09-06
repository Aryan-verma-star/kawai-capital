import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { enrichState } from '@/lib/kavach/live/liveSession';
import { parseBody, rateLimit } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

const Body = z.object({ force: z.boolean().optional() });

/**
 * POST /api/kavach/live/rebalance — the full decision loop:
 * news → Radar → regime → [optimizer + Advisor] → constitution A1–A9 →
 * Critic challenge → autonomy/consent → execute via impact model → recorder.
 * Market-hours gated (09:15–15:30 IST weekdays; force = recorded test hook).
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.res;
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  const res = await s.rebalance(parsed.data.force);
  const st = await enrichState(s.state());
  return NextResponse.json({ ...res, live: st });
}
