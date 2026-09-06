/**
 * KAVACH — news dedupe.
 * Keyed by canonicalized-URL hash; near-duplicates killed by trigram
 * similarity ≥ 0.8 on normalized titles. Pure functions — fully testable.
 */

import { createHash } from 'crypto';
import { Article } from './types';

/** Lowercase, de-punctuated, whitespace-collapsed title. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\u20b9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip trackers, lowercase host, drop trailing slash & empty params. */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|referrer|cmp|share)/i.test(p)) u.searchParams.delete(p);
    }
    let out = u.origin + u.pathname.replace(/\/+$/, '');
    if (u.search && u.search !== '?') out += u.search;
    return out;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

export function urlHash(url: string): string {
  return createHash('sha256').update(canonicalizeUrl(url)).digest('hex').slice(0, 24);
}

/** Character trigrams of a normalized title. */
export function trigrams(s: string): Set<string> {
  const t = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over trigram sets (0..1). */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DedupeResult {
  kept: Article[];
  droppedExact: number;
  droppedNear: number;
}

/**
 * Dedupe a batch: exact URL-hash collisions first, then near-duplicate
 * titles (≥ 0.8 trigram similarity keeps the EARLIEST-published article —
 * originals beat aggregators). O(n²) is fine: batches are ≤ ~150 items.
 */
export function dedupeArticles(articles: Article[]): DedupeResult {
  const byHash = new Map<string, Article>();
  let droppedExact = 0;
  for (const a of articles) {
    const h = urlHash(a.url);
    const existing = byHash.get(h);
    if (!existing) {
      byHash.set(h, a);
      continue;
    }
    droppedExact++;
    // prefer the one with a real publisher name over Google redirect noise
    if (existing.source === 'Google News' && a.source !== 'Google News') byHash.set(h, a);
  }
  const list = [...byHash.values()];
  const kept: Article[] = [];
  const seenTitles: string[] = [];
  let droppedNear = 0;
  // sort oldest-first so originals survive over re-writes
  list.sort((x, y) => (x.publishedAt ?? '9999').localeCompare(y.publishedAt ?? '9999'));
  for (const a of list) {
    const nt = normalizeTitle(a.title);
    let near = false;
    for (const t of seenTitles) {
      if (trigramSimilarity(nt, t) >= 0.8) {
        near = true;
        break;
      }
    }
    if (near) {
      droppedNear++;
      continue;
    }
    seenTitles.push(nt);
    kept.push(a);
  }
  return { kept, droppedExact, droppedNear };
}

/** Headlines the radar cares about (pre-filter: skip sports/entertainment). */
const IRRELEVANT = /cricket|bollywood|ipl\s|kollywood|tollywood|box office|movie|film review|kabaddi|horoscope|astrolog/i;

export function marketRelevant(a: Article): boolean {
  return a.title.length > 15 && !IRRELEVANT.test(a.title);
}
