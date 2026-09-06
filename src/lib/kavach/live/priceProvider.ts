/**
 * KAVACH — price provider (LIVE PAPER).
 *
 * Free, zero-key: Yahoo Finance chart endpoint
 * (query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d).
 * Unofficial and rate-shy — documented as fragile in the README; behind this
 * interface with a 10-minute cache and last-known-good fallback so the app
 * runs even when Yahoo sulks.
 *
 * Symbols: ^NSEI (EQ), USDINR=X (FX), GC=F (gold, USD/oz).
 * GOLD in INR = GC=F × USDINR — RELATIVE moves are applied to the calibrated
 * book, so the paper book's day-0 marks are exactly the constants it was
 * calibrated on and the NAV moves with real market returns from there.
 *
 * GSEC / IGCORP / CRED have no free tickers — those sleeves are marked to
 * model (news-driven yield/spread factors) and labeled MARK-TO-MODEL in the
 * UI. The honest label is a feature.
 */

export interface RealPrices {
  eq: number; // ^NSEI close
  usdinr: number; // USDINR=X
  goldUsd: number; // GC=F ($/oz)
  asOf: string; // ISO of the bar timestamp (or fetch time)
  stale: boolean; // served from last-known-good
}

export interface PriceStatus {
  state: 'ok' | 'stale' | 'error' | 'never';
  lastFetch: number | null;
  lastError?: string;
  asOf?: string;
}

const CACHE_TTL_MS = 10 * 60_000;

interface PriceMemory {
  cache: RealPrices | null;
  fetchedAt: number;
  status: PriceStatus;
}

const g = globalThis as unknown as { __kavachPrices__?: PriceMemory };
const mem: PriceMemory =
  g.__kavachPrices__ ?? (g.__kavachPrices__ = { cache: null, fetchedAt: 0, status: { state: 'never', lastFetch: null } });

export function priceStatus(): PriceStatus {
  return { ...mem.status };
}

/** Parse a Yahoo chart payload into a latest close (pure — fixture-testable). */
export function parseYahooChart(json: unknown): { close: number; asOf: string } | null {
  const chart = (json as { chart?: { result?: unknown[]; error?: unknown } })?.chart;
  const result = (chart?.result ?? [])[0] as
    | {
        meta?: { regularMarketPrice?: number; previousClose?: number; regularMarketTime?: number };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }
    | undefined;
  if (!result) return null;
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  let close = result.meta?.regularMarketPrice;
  if (typeof close !== 'number' || !isFinite(close)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === 'number' && isFinite(c)) {
        close = c;
        break;
      }
    }
  }
  if (typeof close !== 'number' || !isFinite(close)) return null;
  const ts = result.timestamp?.[result.timestamp.length - 1] ?? result.meta?.regularMarketTime;
  return { close, asOf: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString() };
}

async function fetchSymbol(
  symbol: string,
  fetchFn: typeof fetch
): Promise<{ close: number; asOf: string } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 KAVACH/2.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status} for ${symbol}`);
  return parseYahooChart(await res.json());
}

/**
 * Fetch the three real marks (10-min cache, last-known-good fallback).
 * Never throws: returns { stale: true } on failure with the previous marks.
 */
export async function fetchRealPrices(force = false, fetchFn?: typeof fetch): Promise<RealPrices | null> {
  const age = Date.now() - mem.fetchedAt;
  if (!force && mem.cache && age < CACHE_TTL_MS && !fetchFn) {
    return mem.cache;
  }
  const fn = fetchFn ?? fetch;
  try {
    const [eq, fx, gold] = await Promise.all([
      fetchSymbol('^NSEI', fn),
      fetchSymbol('USDINR=X', fn),
      fetchSymbol('GC=F', fn),
    ]);
    if (!eq || !fx || !gold) throw new Error('incomplete yahoo payload');
    const prices: RealPrices = {
      eq: eq.close,
      usdinr: fx.close,
      goldUsd: gold.close,
      asOf: new Date().toISOString(),
      stale: false,
    };
    mem.cache = prices;
    mem.fetchedAt = Date.now();
    mem.status = { state: 'ok', lastFetch: Date.now(), asOf: prices.asOf };
    return prices;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (mem.cache) {
      mem.cache = { ...mem.cache, stale: true };
      mem.status = { state: 'stale', lastFetch: Date.now(), lastError: reason, asOf: mem.cache.asOf };
      return mem.cache;
    }
    mem.status = { state: 'error', lastFetch: Date.now(), lastError: reason };
    return null;
  }
}
