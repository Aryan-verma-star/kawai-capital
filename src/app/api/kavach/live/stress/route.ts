import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';
import { stressLens } from '@/lib/kavach/live/stressLens';
import { BUCKETS } from '@/lib/kavach/constants';
import type { BucketId } from '@/lib/kavach/types';
import type { CrisisId } from '@/lib/kavach/world/scenarios';

export const dynamic = 'force-dynamic';

const Query = z.object({ scenario: z.enum(['TANTRUM-13', 'ILFS-18', 'COVID-20']) });

/**
 * GET /api/kavach/live/stress?scenario=TANTRUM-13
 * What-if pre-mortem: project today's LIVE book through a scripted crisis as
 * a buy-and-hold counterfactual (no trades, no constitution action). Pure,
 * offline, deterministic — the honest counterfactual the governed loop is
 * measured against. Nothing here executes or mutates state.
 */
export async function GET(req: NextRequest) {
  const q = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) {
    return NextResponse.json(
      { error: 'scenario must be one of TANTRUM-13 | ILFS-18 | COVID-20' },
      { status: 400 }
    );
  }
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });

  const values = {} as Record<BucketId, number>;
  for (const b of BUCKETS) values[b] = s.book.bucketValue(b);

  const result = stressLens(
    { values, cash: s.book.cash, borrowings: s.book.borrowings },
    q.data.scenario as CrisisId
  );
  return NextResponse.json({ ok: true, ...result });
}
