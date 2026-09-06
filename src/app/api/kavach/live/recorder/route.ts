import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { parseQuery } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * GET /api/kavach/live/recorder?from=&to=&limit= — hash-chained entries of
 * the LIVE session (the audit artifact). Range-filtered, newest-last,
 * chain-validity reported with the response.
 */
export async function GET(req: NextRequest) {
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  const q = parseQuery(req, Query);
  if (!q.ok) return q.res;
  const from = q.data.from ?? 0;
  const to = q.data.to ?? 9999;
  const limit = q.data.limit ?? 200;
  const entries = s.recorder.range(from, to).slice(-limit);
  return NextResponse.json({
    mode: 'live',
    sessionId: s.id,
    from,
    to,
    count: entries.length,
    total: s.recorder.size(),
    headHash: s.recorder.headHash(),
    chainValid: s.recorder.verify(),
    entries,
  });
}
