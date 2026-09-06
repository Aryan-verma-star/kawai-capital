/**
 * KAVACH — news pipeline.
 * fetch (all enabled providers, Promise.allSettled) → normalize → dedupe
 * (URL hash + trigram ≥ 0.8) → persist (articles table, URL-hash keyed) →
 * 15-minute TTL cache → radar input.
 *
 * Provider failures are logged, never fatal. If EVERY provider fails the
 * pipeline reports NEWS FEED DEGRADED and keeps running on the last cached
 * set. CI never touches the network: tests inject fixture fetch functions.
 */

import { Article, NewsProvider, NewsProviderStatus } from './types';
import { TOPIC_QUERIES } from './types';
import { dedupeArticles, marketRelevant, urlHash } from './dedupe';
import { googleNewsProvider } from './googleNews';
import { gdeltProvider } from './gdelt';
import { gnewsProvider, marketauxProvider, finnhubProvider } from './keyed';

const TTL_MS = 15 * 60_000;
const MAX_ARTICLES = 150;

interface NewsMemory {
  cache: { articles: Article[]; at: number };
  statuses: Record<string, NewsProviderStatus>;
  inflight: Promise<NewsFetchResult> | null;
}

const g = globalThis as unknown as { __kavachNews__?: NewsMemory };
const mem: NewsMemory =
  g.__kavachNews__ ??
  (g.__kavachNews__ = {
    cache: { articles: [], at: 0 },
    statuses: {},
    inflight: null,
  });

export interface NewsFetchResult {
  articles: Article[];
  fetchedAt: number;
  degraded: boolean; // ALL providers failed — running on cache
  fresh: number; // newly persisted this fetch
  statuses: NewsProviderStatus[];
}

function providerEnabled(p: NewsProvider): boolean {
  return p.envKey === '' || Boolean(process.env[p.envKey]);
}

function setStatus(p: NewsProvider, ok: boolean, count: number, error?: string): void {
  mem.statuses[p.name] = {
    provider: p.name,
    enabled: providerEnabled(p),
    ok,
    count,
    lastFetch: Date.now(),
    lastError: error,
  };
}

const PROVIDERS: NewsProvider[] = [
  googleNewsProvider,
  gdeltProvider,
  gnewsProvider,
  marketauxProvider,
  finnhubProvider,
];

async function persistArticles(articles: Article[]): Promise<number> {
  let fresh = 0;
  try {
    const { db } = await import('../../db');
    for (const a of articles.slice(0, MAX_ARTICLES)) {
      const h = urlHash(a.url);
      const exists = await db.article.findUnique({ where: { urlHash: h }, select: { id: true } });
      if (exists) continue;
      await db.article.create({
        data: {
          urlHash: h,
          url: a.url,
          title: a.title.slice(0, 500),
          source: a.source.slice(0, 200),
          provider: a.provider,
          publishedAt: a.publishedAt ? new Date(a.publishedAt) : undefined,
          snippet: a.snippet?.slice(0, 500),
          sentiment: a.sentiment,
          dedupeKey: a.title.slice(0, 200),
        },
      });
      fresh++;
    }
  } catch {
    // persistence must never break ingestion
  }
  return fresh;
}

async function doFetch(force: boolean, fetchFn?: typeof fetch): Promise<NewsFetchResult> {
  const enabled = PROVIDERS.filter(providerEnabled);
  const results = await Promise.allSettled(
    enabled.map((p) => p.fetchMany(TOPIC_QUERIES, fetchFn ? { fetchFn } : undefined))
  );
  let collected: Article[] = [];
  let anyOk = false;
  enabled.forEach((p, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      anyOk = anyOk || r.value.length > 0;
      setStatus(p, true, r.value.length);
      collected = collected.concat(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      setStatus(p, false, 0, reason);
    }
  });

  let degraded = false;
  let articles = mem.cache.articles;
  let fresh = 0;
  if (anyOk) {
    const { kept } = dedupeArticles(collected.filter(marketRelevant));
    articles = kept.slice(0, MAX_ARTICLES);
    fresh = await persistArticles(articles);
    mem.cache = { articles, at: Date.now() };
  } else if (enabled.length === 0) {
    mem.cache = { articles: [], at: Date.now() };
    articles = [];
  } else {
    degraded = true; // keep last cached set
    mem.cache.at = Date.now();
  }
  return {
    articles,
    fetchedAt: mem.cache.at,
    degraded,
    fresh,
    statuses: newsStatuses(),
  };
}

export function newsStatuses(): NewsProviderStatus[] {
  return PROVIDERS.map(
    (p) =>
      mem.statuses[p.name] ?? {
        provider: p.name,
        enabled: providerEnabled(p),
        ok: false,
        count: 0,
        lastFetch: null,
      }
  );
}

/** TTL-cached fetch (15 min). Concurrent callers share one inflight fetch. */
export async function fetchNews(force = false, fetchFn?: typeof fetch): Promise<NewsFetchResult> {
  const age = Date.now() - mem.cache.at;
  if (!force && mem.cache.at > 0 && age < TTL_MS && !fetchFn) {
    return {
      articles: mem.cache.articles,
      fetchedAt: mem.cache.at,
      degraded: false,
      fresh: 0,
      statuses: newsStatuses(),
    };
  }
  if (mem.inflight && !force) return mem.inflight;
  const p = doFetch(force, fetchFn);
  mem.inflight = p;
  try {
    return await p;
  } finally {
    mem.inflight = null;
  }
}

export function cachedNews(): Article[] {
  return mem.cache.articles;
}

/** Most recent articles from the DB (across restarts). */
export async function recentArticles(limit = 40): Promise<Article[]> {
  try {
    const { db } = await import('../../db');
    const rows = await db.article.findMany({
      orderBy: { fetchedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      title: r.title,
      url: r.url,
      source: r.source,
      publishedAt: r.publishedAt?.toISOString(),
      sentiment: r.sentiment ?? undefined,
      provider: r.provider,
    }));
  } catch {
    return [];
  }
}
