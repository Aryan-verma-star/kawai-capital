/**
 * KAVACH — news ingestion types.
 * Providers are adapters behind one interface; all topics are India-flavoured.
 * Failures are never fatal (A9 philosophy everywhere).
 */

export interface Article {
  title: string;
  url: string;
  source: string;
  publishedAt?: string; // ISO
  snippet?: string;
  sentiment?: number; // −1..1 (provider-supplied if any)
  provider: string; // googlenews | gdelt | gnews | marketaux | finnhub
}

export interface NewsProviderStatus {
  provider: string;
  enabled: boolean;
  ok: boolean;
  count: number;
  lastFetch: number | null;
  lastError?: string;
}

export interface NewsProvider {
  readonly name: string;
  /** env var holding the API key ('' = zero-key provider, always on). */
  readonly envKey: string;
  fetchMany(
    queries: string[],
    opts?: { fetchFn?: typeof fetch; gapMs?: number }
  ): Promise<Article[]>;
}

/**
 * Topic queries per book sleeve — the Radar's diet. Google-News `when:` and
 * GDELT `timespan` operators are appended by each adapter as it supports them.
 */
export const TOPIC_QUERIES: string[] = [
  'NIFTY 50 OR Sensex',
  'RBI repo rate',
  'NBFC default',
  'rupee dollar',
  'gold price India',
  'G-Sec yield India',
  'IL&FS OR DHFL OR credit crisis India',
  'FPI outflow India',
];
