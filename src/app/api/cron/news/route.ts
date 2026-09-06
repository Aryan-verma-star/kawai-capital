import { NextRequest, NextResponse } from 'next/server';
import { fetchNews } from '@/lib/kavach/news/pipeline';
import { getLive } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/news — the 15-minute news poll (Vercel Cron hits this; also
 * manually invocable). Zero-key providers (Google News RSS + GDELT) plus any
 * env-gated keyed ones; refreshes the LIVE radar on its own 15-min cadence.
 * If CRON_SECRET is set, requires Authorization: Bearer <secret> or ?secret=.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    const q = req.nextUrl.searchParams.get('secret');
    if (auth !== `Bearer ${secret}` && q !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const t0 = Date.now();
  const news = await fetchNews(false);
  let radar = 0;
  const s = await getLive().catch(() => null);
  if (s && s.status === 'RUNNING') {
    const logs = await s.refreshRadar(false).catch(() => []);
    radar = logs.length;
  }
  return NextResponse.json({
    ok: true,
    latencyMs: Date.now() - t0,
    articles: news.articles.length,
    fresh: news.fresh,
    degraded: news.degraded,
    radarEvents: radar,
    providers: news.statuses,
  });
}
