/**
 * KAVACH — API hardening (R6).
 * zod validation helpers + a simple in-memory rate limit (60 req/min/IP)
 * on AI-triggering endpoints. No key ever reaches the client bundle; this
 * module is server-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const WINDOW_MS = 60_000;
const LIMIT = 60;

interface Bucket {
  hits: number[];
}

const g = globalThis as unknown as { __kavachRate__?: Map<string, Bucket> };
const buckets = g.__kavachRate__ ?? (g.__kavachRate__ = new Map<string, Bucket>());

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/** Returns null when allowed; a 429 NextResponse when limited. */
export function rateLimit(req: NextRequest): NextResponse | null {
  const ip = clientIp(req);
  const now = Date.now();
  const b = buckets.get(ip) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < WINDOW_MS);
  if (b.hits.length >= LIMIT) {
    buckets.set(ip, b);
    return NextResponse.json(
      { error: 'rate limited — 60 requests/minute per IP on AI endpoints' },
      { status: 429 }
    );
  }
  b.hits.push(now);
  buckets.set(ip, b);
  return null;
}

/** Parse and validate a JSON body against a zod schema; 400 on mismatch. */
export async function parseBody<T>(
  req: NextRequest,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; res: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'validation failed', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Validate query params; 400 on mismatch. */
export function parseQuery<T>(
  req: NextRequest,
  schema: z.ZodType<T>
): { ok: true; data: T } | { ok: false; res: NextResponse } {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => (obj[k] = v));
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'invalid query', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
