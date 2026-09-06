/**
 * KAVACH — GDELT DOC 2.0 provider (zero key, default ON).
 * Global coverage including Indian media; articles carry tone scores we map
 * to a coarse sentiment. Polled at the 15-minute cadence alongside RSS.
 */

import { Article, NewsProvider, TOPIC_QUERIES } from './types';

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string; // "20260112T063000Z"
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

/**
 * GDELT etiquette constants: ≤1 req / 5 s per IP, keep the topic list short,
 * and bound the whole provider to ~17 s worst case (2 queries × 6 s timeout +
 * one gap) so the 15-minute cron never blocks for half a minute.
 */
export const GDELT_QUERY_GAP_MS = 5_200;
export const GDELT_MAX_QUERIES = 2;
export const GDELT_FETCH_TIMEOUT_MS = 6_000;

/**
 * GDELT answers rate-limiting with HTTP 200 + this TEXT body (not JSON).
 * Detect it explicitly so the provider can fail honestly instead of
 * parsing to "0 articles, ok: true".
 */
export function isGdeltThrottleText(text: string): boolean {
  return text.includes('Please limit requests to one every 5 seconds');
}

/** Parse a GDELT DOC 2.0 artlist JSON payload (pure — testable on fixtures). */
export function parseGdelt(json: unknown): Article[] {
  const res = (json ?? {}) as GdeltResponse;
  if (!Array.isArray(res.articles)) return [];
  const out: Article[] = [];
  for (const a of res.articles) {
    if (typeof a.url !== 'string' || !a.url || typeof a.title !== 'string' || !a.title) continue;
    let publishedAt: string | undefined;
    if (typeof a.seendate === 'string' && /^\d{8}T\d{6}Z$/.test(a.seendate)) {
      const s = a.seendate;
      publishedAt = new Date(
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
      ).toISOString();
    }
    out.push({
      title: a.title,
      url: a.url,
      source: a.domain ?? 'GDELT',
      publishedAt,
      provider: 'gdelt',
    });
  }
  return out;
}

export const gdeltProvider: NewsProvider = {
  name: 'gdelt',
  envKey: '',
  async fetchMany(queries = TOPIC_QUERIES, opts): Promise<Article[]> {
    const fetchFn = opts?.fetchFn ?? fetch;
    const gapMs = opts?.gapMs ?? GDELT_QUERY_GAP_MS;
    const all: Article[] = [];
    const qs = queries.slice(0, GDELT_MAX_QUERIES);
    const errors: string[] = [];
    // GDELT etiquette: ≤ 1 request / 5 s per IP. Firing the topic list
    // concurrently trips their throttle, which answers HTTP 200 with a TEXT
    // body — previously JSON.parse-failed silently and health lied with
    // "ok: true, count: 0". Queries are now serialized with a spacing gap
    // and a throttle body is an explicit, honest failure.
    for (let i = 0; i < qs.length; i++) {
      if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      const q = qs[i];
      const url =
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}` +
        `&mode=artlist&maxrecords=25&format=json&timespan=2d`;
      try {
        const res = await fetchFn(url, {
          signal: AbortSignal.timeout(GDELT_FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'KAVACH/2.0 (+educational research console)' },
        });
        if (!res.ok) throw new Error(`gdelt HTTP ${res.status} for "${q}"`);
        const text = await res.text();
        if (isGdeltThrottleText(text)) {
          throw new Error(`gdelt etiquette throttle on "${q}" — upstream asks ≤1 req/5 s per IP`);
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          continue; // GDELT occasionally returns empty/non-JSON on odd queries
        }
        all.push(...parseGdelt(json));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (all.length === 0 && errors.length === qs.length && qs.length > 0) {
      // every query failed → provider is effectively down → throw so the
      // pipeline records ok:false + lastError (honest degraded state)
      throw new Error(errors[0]);
    }
    return all;
  },
};
