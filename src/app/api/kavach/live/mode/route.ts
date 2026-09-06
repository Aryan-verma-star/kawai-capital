import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { enrichState } from '@/lib/kavach/live/liveSession';
import { parseBody, rateLimit } from '@/lib/kavach/apiHardening';
import type { AutonomyLevel } from '@/lib/kavach/types';

export const dynamic = 'force-dynamic';

const Body = z.object({ autonomy: z.enum(['FULL', 'SUPERVISED', 'CONSERVATIVE']) });

/**
 * POST /api/kavach/live/mode — set the autonomy dial on the LIVE book.
 * The one-way ratchet binds: while the regime is CRISIS the dial may only
 * move toward MORE scrutiny; blocked attempts are recorded (ratchetEvents).
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.res;
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  const applied = s.bot.autonomy.setLevel(parsed.data.autonomy as AutonomyLevel, s.day);
  const last = s.bot.autonomy.ratchetEvents[s.bot.autonomy.ratchetEvents.length - 1];
  if (last && !last.blocked) {
    s.recorder.record(s.day, 'AUTONOMY', {
      day: s.day,
      from: last.from,
      to: last.to,
      by: 'Treasury Head',
      channel: 'api',
    });
  } else if (last && last.blocked) {
    s.recorder.record(s.day, 'RATCHET_BLOCK', {
      day: s.day,
      attempted: parsed.data.autonomy,
      current: s.bot.autonomy.level,
      reason: 'one-way ratchet: CRISIS regime permits only more scrutiny',
    });
  }
  await s.persistSnapshot();
  const st = await enrichState(s.state());
  return NextResponse.json({
    ok: applied,
    autonomy: s.bot.autonomy.level,
    ratchetArmed: s.bot.autonomy.isRatchetArmed(),
    note: applied
      ? `autonomy set to ${s.bot.autonomy.level}`
      : 'one-way ratchet active (CRISis regime): may only move toward more scrutiny',
    live: st,
  });
}
