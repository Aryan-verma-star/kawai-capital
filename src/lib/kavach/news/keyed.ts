/**
 * KAVACH — optional keyed news providers (env-gated, OFF unless key present).
 * One shared adapter each: GNews (free ~100/day), Marketaux (free ~100/day,
 * entity + sentiment tags), Finnhub (free, general category news).
 */

import { Article, NewsProvider, TOPIC_QUERIES } from './types';

// ---------------------------------------------------------------- GNews

interface GnewsResponse {
  articles?: {
    title?: string;
    description?: string;
    url?: string;
    publishedAt?: string;
    source?: { name?: string };
  }[];
}

export function parseGnews(json: unknown): Article[] {
  const res = (json ?? {}) as GnewsResponse;
  if (!Array.isArray(res.articles)) return [];
  const out: Article[] = [];
  for (const a of res.articles) {
    if (typeof a.url !== 'string' || !a.url || typeof a.title !== 'string' || !a.title) continue;
    out.push({
      title: a.title,
      url: a.url,
      source: a.source?.name ?? 'GNews',
      publishedAt: a.publishedAt,
      snippet: typeof a.description === 'string' ? a.description.slice(0, 300) : undefined,
      provider: 'gnews',
    });
  }
  return out;
}

export const gnewsProvider: NewsProvider = {
  name: 'gnews',
  envKey: 'GNEWS_API_KEY',
  async fetchMany(queries = TOPIC_QUERIES, opts): Promise<Article[]> {
    const key = process.env.GNEWS_API_KEY;
    if (!key) return [];
    const fetchFn = opts?.fetchFn ?? fetch;
    const all: Article[] = [];
    // free tier ~100/day: 3 queries × 10 items, India edition
    await Promise.allSettled(
      queries.slice(0, 3).map(async (q) => {
        const url =
          `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&country=in&max=10&apikey=${key}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`gnews HTTP ${res.status}`);
        all.push(...parseGnews(await res.json()));
      })
    );
    return all;
  },
};

// ---------------------------------------------------------------- Marketaux

interface MarketauxResponse {
  data?: {
    title?: string;
    description?: string;
    url?: string;
    published_at?: string;
    source?: string;
    entities?: { sentiment_score?: number }[];
  }[];
}

export function parseMarketaux(json: unknown): Article[] {
  const res = (json ?? {}) as MarketauxResponse;
  if (!Array.isArray(res.data)) return [];
  const out: Article[] = [];
  for (const a of res.data) {
    if (typeof a.url !== 'string' || !a.url || typeof a.title !== 'string' || !a.title) continue;
    const sent = (a.entities ?? [])
      .map((e) => e.sentiment_score)
      .filter((s): s is number => typeof s === 'number');
    out.push({
      title: a.title,
      url: a.url,
      source: a.source ?? 'Marketaux',
      publishedAt: a.published_at,
      snippet: typeof a.description === 'string' ? a.description.slice(0, 300) : undefined,
      sentiment: sent.length ? sent.reduce((x, y) => x + y, 0) / sent.length : undefined,
      provider: 'marketaux',
    });
  }
  return out;
}

export const marketauxProvider: NewsProvider = {
  name: 'marketaux',
  envKey: 'MARKETAUX_API_KEY',
  async fetchMany(queries = TOPIC_QUERIES, opts): Promise<Article[]> {
    const key = process.env.MARKETAUX_API_KEY;
    if (!key) return [];
    const fetchFn = opts?.fetchFn ?? fetch;
    const all: Article[] = [];
    await Promise.allSettled(
      queries.slice(0, 4).map(async (q) => {
        const url =
          `https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(q)}` +
          `&language=en&limit=10&api_token=${key}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`marketaux HTTP ${res.status}`);
        all.push(...parseMarketaux(await res.json()));
      })
    );
    return all;
  },
};

// ---------------------------------------------------------------- Finnhub

interface FinnhubArticle {
  headline?: string;
  summary?: string;
  url?: string;
  datetime?: number; // epoch seconds
  source?: string;
}

export function parseFinnhub(json: unknown, keywordFilter: string[]): Article[] {
  const list = Array.isArray(json) ? (json as FinnhubArticle[]) : [];
  const out: Article[] = [];
  const kw = keywordFilter.join('|');
  const re = kw ? new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : /.^/;
  for (const a of list) {
    if (typeof a.url !== 'string' || !a.url || typeof a.headline !== 'string' || !a.headline) continue;
    const text = a.headline + ' ' + (a.summary ?? '');
    // sports/entertainment noise dies first — "India wins the match" is not market news
    if (/cricket|bollywood|ipl\s|kabaddi|box office|movie|film|kollywood|tollywood|horoscope/i.test(text)) continue;
    // then keep only India/market-relevant headlines
    if (
      !/india|nifty|sensex|rupee|rbi|nbf|g-?sec|gold|mumbai|delhi|fpi|crisil|il&fs|dhfl|reliance|hdfc|infosys|tcs|sbi|icici/i.test(text) &&
      !(kw && re.test(a.headline))
    ) {
      continue;
    }
    out.push({
      title: a.headline,
      url: a.url,
      source: a.source ?? 'Finnhub',
      publishedAt: a.datetime ? new Date(a.datetime * 1000).toISOString() : undefined,
      snippet: typeof a.summary === 'string' ? a.summary.slice(0, 300) : undefined,
      provider: 'finnhub',
    });
  }
  return out;
}

export const finnhubProvider: NewsProvider = {
  name: 'finnhub',
  envKey: 'FINNHUB_API_KEY',
  async fetchMany(queries = TOPIC_QUERIES, opts): Promise<Article[]> {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return [];
    const fetchFn = opts?.fetchFn ?? fetch;
    const url = `https://finnhub.io/api/v1/news?category=general&token=${key}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`finnhub HTTP ${res.status}`);
    return parseFinnhub(await res.json(), queries.slice(0, 4));
  },
};
