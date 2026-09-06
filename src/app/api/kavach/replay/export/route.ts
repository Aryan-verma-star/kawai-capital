import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { store } from '@/lib/kavach/store';
import { AgentMode } from '@/lib/kavach/types';
import { CR } from '@/lib/kavach/constants';

export const dynamic = 'force-dynamic';

/**
 * Replay exports (the A/B evidence pack):
 *   kind=equity   → CSV of both bots' NAV + drawdown curves, day by day
 *   kind=recorder → the hash-chained JSONL for one bot (?bot=naive|governed)
 */

const Kind = z.enum(['equity', 'recorder']);
const Bot = z.enum(['naive', 'governed']);

export async function GET(req: NextRequest) {
  const kind = Kind.safeParse(req.nextUrl.searchParams.get('kind') ?? 'equity');
  if (!kind.success) {
    return NextResponse.json({ error: 'kind must be equity | recorder' }, { status: 400 });
  }
  const r = store.replay;
  if (!r || !r.scenario) return NextResponse.json({ error: 'no active replay' }, { status: 404 });

  if (kind.data === 'recorder') {
    const botParsed = Bot.safeParse(req.nextUrl.searchParams.get('bot') ?? 'governed');
    if (!botParsed.success) return NextResponse.json({ error: 'bot must be naive | governed' }, { status: 400 });
    const s = r.sessions[botParsed.data as AgentMode];
    if (!s) return NextResponse.json({ error: `no ${botParsed.data} session in this replay` }, { status: 404 });
    const lines = s.recorder
      .all()
      .map((e) => JSON.stringify(e))
      .join('\n');
    return new NextResponse(lines + (lines ? '\n' : ''), {
      status: 200,
      headers: {
        'content-type': 'application/jsonl; charset=utf-8',
        'content-disposition': `attachment; filename="kavach-${String(r.scenario).toLowerCase()}-${botParsed.data}.jsonl"`,
        'cache-control': 'no-store',
      },
    });
  }

  // equity CSV: day,naive_nav_cr,governed_nav_cr,naive_dd_pct,governed_dd_pct
  const n = r.sessions['naive']?.snapshot();
  const g = r.sessions['governed']?.snapshot();
  if (!n && !g) return NextResponse.json({ error: 'no bot sessions in this replay' }, { status: 404 });
  const at = (arr: { day: number; nav: number; dd: number }[] | undefined, d: number) =>
    arr?.find((p) => p.day === d);
  const days = Math.max(n?.navSeries.length ?? 0, g?.navSeries.length ?? 0, 1);
  const header = 'day,naive_nav_cr,governed_nav_cr,naive_dd_pct,governed_dd_pct';
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    const np = at(n?.navSeries, d);
    const gp = at(g?.navSeries, d);
    rows.push(
      [
        d,
        np ? (np.nav / CR).toFixed(3) : '',
        gp ? (gp.nav / CR).toFixed(3) : '',
        np ? (np.dd * 100).toFixed(2) : '',
        gp ? (gp.dd * 100).toFixed(2) : '',
      ].join(',')
    );
  }
  return new NextResponse([header, ...rows].join('\n') + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="kavach-${String(r.scenario).toLowerCase()}-equity.csv"`,
      'cache-control': 'no-store',
    },
  });
}
