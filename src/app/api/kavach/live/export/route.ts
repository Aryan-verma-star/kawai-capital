import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLive } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

/**
 * The regulator pack: download the session's evidence.
 *   kind=recorder → the hash-chained JSONL (one line per entry, hashes intact)
 *   kind=trades   → CSV blotter of executed paper trades (recorder-derived)
 *   kind=history  → CSV of daily book snapshots (NAV/gross/cash/borrow/regime)
 * Everything exported is derived from the recorder / SQLite — no parallel
 * accounting is ever created for export.
 */

const Kind = z.enum(['recorder', 'trades', 'history']);

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

export async function GET(req: NextRequest) {
  const parsed = Kind.safeParse(req.nextUrl.searchParams.get('kind') ?? 'recorder');
  if (!parsed.success) {
    return NextResponse.json({ error: 'kind must be recorder | trades | history' }, { status: 400 });
  }
  const session = await getLive();
  if (!session) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  const kind = parsed.data;
  const idShort = session.id.slice(0, 10);

  if (kind === 'recorder') {
    const lines = session.recorder
      .all()
      .map((e) => JSON.stringify(e))
      .join('\n');
    return new NextResponse(lines + (lines ? '\n' : ''), {
      status: 200,
      headers: {
        'content-type': 'application/jsonl; charset=utf-8',
        'content-disposition': `attachment; filename="kavach-live-${idShort}.jsonl"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (kind === 'trades') {
    const st = session.state();
    // guard: a session resumed from a pre-blotter build simply exports no legs
    const trades = st.trades ?? [];
    const header = 'day,kind,bucket,dir,value_cr,participation_pct,impact_cost_cr,origin,re_clipped,reason';
    const rows = trades.map((t) =>
      [
        t.day,
        t.kind,
        t.bucket,
        t.dir === 1 ? 'BUY' : 'SELL',
        t.valueCr.toFixed(2),
        (t.participation * 100).toFixed(1),
        t.impactCostCr.toFixed(3),
        t.origin,
        t.reClipped ? 'yes' : 'no',
        csvEscape(t.reason),
      ].join(',')
    );
    return csvResponse([header, ...rows].join('\n'), `kavach-blotter-${idShort}.csv`);
  }

  // history: daily book snapshots from SQLite
  const { db } = await import('@/lib/db');
  const snaps = await db.bookSnapshot.findMany({
    where: { sessionId: session.id },
    orderBy: { day: 'asc' },
  });
  const header = 'day,nav_cr,gross_cr,cash_cr,borrow_cr,regime';
  const rows = snaps.map((s) =>
    [s.day, s.navCr.toFixed(2), (s.grossCr ?? 0).toFixed(2), (s.cashCr ?? 0).toFixed(2), (s.borrowCr ?? 0).toFixed(2), s.regime ?? ''].join(',')
  );
  return csvResponse([header, ...rows].join('\n'), `kavach-history-${idShort}.csv`);
}
