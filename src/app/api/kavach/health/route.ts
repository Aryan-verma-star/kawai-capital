import { NextRequest, NextResponse } from 'next/server';
import { store, checkLlm } from '@/lib/kavach/store';
import { SCENARIOS } from '@/lib/kavach/world/scenarios';
import { geminiStatusSync, aiBudgetUsedToday, aiBudgetLimit } from '@/lib/kavach/llm/gemini';
import { priceStatus } from '@/lib/kavach/live/priceProvider';
import { marketStatus } from '@/lib/kavach/live/marketHours';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kavach/health — v2.
 * {status, db, gemini: ok|fallback|nokey, news: [provider statuses],
 *  price: ok|stale|error|never, mode, budget_used/limit, market, replay}.
 * Always truthful, including degraded states.
 */
export async function GET(_req: NextRequest) {
  const llm = await checkLlm();
  const gemini = geminiStatusSync();
  let db: 'ok' | 'error' = 'ok';
  let dbError: string | null = null;
  try {
    const { db: prisma } = await import('@/lib/db');
    await prisma.kavachSession.count();
  } catch (e) {
    db = 'error';
    dbError = e instanceof Error ? e.message : String(e);
  }
  let news: { provider: string; enabled: boolean; ok: boolean; count: number; lastFetch: number | null; lastError?: string }[] = [];
  try {
    const { newsStatuses } = await import('@/lib/kavach/news/pipeline');
    news = newsStatuses();
  } catch {
    news = [];
  }
  const r = store.replay;
  const s = store.live;
  const budget = { used: await aiBudgetUsedToday(), limit: aiBudgetLimit() };
  return NextResponse.json({
    status: 'ok',
    service: 'kavach',
    version: '2.0.0',
    db,
    dbError,
    gemini: {
      state: gemini.state, // ok | fallback | nokey | budget
      model: gemini.model,
      breakerOpen: gemini.breakerOpen,
      breakerReason: gemini.breakerReason ?? null,
      lastOutcome: gemini.lastOutcome
        ? { outcome: gemini.lastOutcome.outcome, at: gemini.lastOutcome.at, reason: gemiumReason(gemini.lastOutcome.reason) }
        : null,
      available: llm.available,
    },
    news: news.map((n) => ({
      provider: n.provider,
      enabled: n.enabled,
      ok: n.ok,
      count: n.count,
      lastFetch: n.lastFetch,
      lastError: n.lastError ?? null,
    })),
    price: priceStatus(),
    market: marketStatus(),
    mode: s ? 'live' : r ? 'replay' : 'idle',
    budget,
    replay: r
      ? {
          scenario: r.scenario,
          day: r.day,
          complete: r.complete,
          mode: r.mode,
          recorderEntries: {
            naive: r.sessions['naive']?.recorder.size() ?? 0,
            governed: r.sessions['governed']?.recorder.size() ?? 0,
          },
          recorderChainValid: {
            naive: r.sessions['naive']?.recorder.verify() ?? true,
            governed: r.sessions['governed']?.recorder.verify() ?? true,
          },
        }
      : null,
    live: s ? { sessionId: s.id, day: s.day, status: s.status, nav: s.state().nav } : null,
    scenarios: Object.values(SCENARIOS).map((sc) => ({ id: sc.id, title: sc.title, days: sc.days })),
  });
}

function gemiumReason(r?: string): string | null {
  return r ? r.slice(0, 200) : null;
}
