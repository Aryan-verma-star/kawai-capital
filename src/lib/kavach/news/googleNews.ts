/**
 * KAVACH — Google News RSS provider (zero key, default ON).
 * India edition: hl=en-IN&gl=IN&ceid=IN:en. Parsed with fast-xml-parser.
 * Titles arrive like "Rupee slips 10 paise … - Economic Times"; the source
 * suffix is stripped and attributed properly. Links point back to the
 * publisher (via Google's redirect) and are kept verbatim for audit.
 */

import { XMLParser } from 'fast-xml-parser';
import { Article, NewsProvider, TOPIC_QUERIES } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

export interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  source?: string | { '#text'?: string; '@_url'?: string };
}

/** Parse a Google News RSS document into articles (pure — testable on fixtures). */
export function parseGoogleNewsRss(xml: string): Article[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const channel = (doc as { rss?: { channel?: { item?: RssItem | RssItem[] } } })?.rss?.channel;
  const items = channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  const out: Article[] = [];
  for (const it of list) {
    const rawTitle = typeof it.title === 'string' ? it.title : '';
    if (!rawTitle || typeof it.link !== 'string' || !it.link) continue;
    // Google suffixes " - Publisher"; extract it for attribution
    let title = rawTitle;
    let source = '';
    const m = rawTitle.match(/^(.*)\s+-\s+([^-]{2,60})$/);
    if (m) {
      title = m[1].trim();
      source = m[2].trim();
    }
    const srcTag =
      typeof it.source === 'string'
        ? it.source
        : it.source?.['#text'] ?? '';
    if (!source) source = srcTag || 'Google News';
    const published = typeof it.pubDate === 'string' ? new Date(it.pubDate).toISOString() : undefined;
    const snippet =
      typeof it.description === 'string'
        ? it.description.replace(/<[^>]+>/g, '').slice(0, 300)
        : undefined;
    out.push({ title, url: it.link, source, publishedAt: published, snippet, provider: 'googlenews' });
  }
  return out;
}

export const googleNewsProvider: NewsProvider = {
  name: 'googlenews',
  envKey: '',
  async fetchMany(queries = TOPIC_QUERIES, opts): Promise<Article[]> {
    const fetchFn = opts?.fetchFn ?? fetch;
    const all: Article[] = [];
    await Promise.allSettled(
      queries.slice(0, 8).map(async (q) => {
        const url =
          `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}` +
          `&hl=en-IN&gl=IN&ceid=IN:en`;
        const res = await fetchFn(url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'KAVACH/2.0 (+educational research console)' },
        });
        if (!res.ok) throw new Error(`googlenews HTTP ${res.status} for "${q}"`);
        const xml = await res.text();
        all.push(...parseGoogleNewsRss(xml));
      })
    );
    return all;
  },
};
