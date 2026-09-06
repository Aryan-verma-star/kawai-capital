import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';
import { AgentMode } from '@/lib/kavach/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const from = Number.isFinite(Number(sp.get('from'))) ? Number(sp.get('from')) : 0;
  const toRaw = Number(sp.get('to'));
  const to = Number.isFinite(toRaw) ? toRaw : 9999;
  const botParam = String(sp.get('bot') ?? 'governed');
  const bot = (['naive', 'governed'].includes(botParam) ? botParam : 'governed') as AgentMode;
  const limitRaw = Number(sp.get('limit'));
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;
  const entries = r.recorderRange(bot, from, to).slice(-limit);
  return NextResponse.json({
    bot,
    scenario: r.scenario,
    from,
    to,
    count: entries.length,
    headHash: r.sessions[bot]?.recorder.headHash() ?? '',
    chainValid: r.sessions[bot]?.recorder.verify() ?? true,
    entries,
  });
}
