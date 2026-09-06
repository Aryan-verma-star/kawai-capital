import { NextRequest, NextResponse } from 'next/server';
import { getLive } from '@/lib/kavach/store';
import { enrichState } from '@/lib/kavach/live/liveSession';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kavach/live/state — the full LIVE PAPER state (fast: caches only).
 * On first sight of a session with no marks yet, kicks a background price
 * poll (10-min cache, last-known-good fallback) so the Real marks panel
 * populates without a manual click.
 */
export async function GET(_req: NextRequest) {
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  if (!s.book.lastReal) {
    void s.pollPrices().catch(() => undefined);
  }
  const st = await enrichState(s.state());
  return NextResponse.json({ ok: true, live: st });
}
