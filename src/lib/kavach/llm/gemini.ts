/**
 * KAVACH — Gemini adapter (production LLM layer).
 *
 * Every AI touchpoint goes through this one module. Guarantees:
 *  - Structured output: responseMimeType JSON + native responseSchema
 *    (enums for severity/direction ⇒ invalid outputs are impossible at the
 *    source), then zod validation after parsing (defense in depth).
 *  - Free-tier discipline: client-side limiter ≤ 8 req/min, 10 s timeout,
 *    exactly ONE retry on 429/5xx with backoff, then circuit-break to
 *    fallback for 10 minutes.
 *  - Hard budget: MAX_AI_CALLS_PER_DAY (default 150) counted per IST day in
 *    the DB (ai_calls). When spent → dictionary mode + visible badge.
 *  - Audit: every call (success, fallback, rejection, timeout, budget) is
 *    persisted with role, model, prompt hash, latency, tokens, outcome.
 *
 * The adapter never throws; failures return { ok: false } and the caller
 * falls back deterministically. AI is perception + narrative — zero authority.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

export type AiRole = 'radar' | 'advisor' | 'critic' | 'narrator' | 'probe';
export type AiOutcome =
  | 'ok'
  | 'nokey'
  | 'budget'
  | 'rate_limited'
  | 'timeout'
  | 'fallback'
  | 'rejected';

export interface AiCallResult<T> {
  ok: boolean;
  data?: T;
  outcome: AiOutcome;
  reason?: string;
  latencyMs: number;
  model: string;
}

interface GeminiMemory {
  limiter: number[]; // timestamps (ms) of recent calls
  breaker: { openUntil: number; consecFailures: number; reason?: string };
  lastOutcome: { outcome: AiOutcome; at: number; reason?: string } | null;
  client: unknown | null;
}

const g = globalThis as unknown as { __kavachGemini__?: GeminiMemory };
const mem: GeminiMemory =
  g.__kavachGemini__ ??
  (g.__kavachGemini__ = {
    limiter: [],
    breaker: { openUntil: 0, consecFailures: 0 },
    lastOutcome: null,
    client: null,
  });

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
}

export function aiBudgetLimit(): number {
  const n = Number(process.env.MAX_AI_CALLS_PER_DAY);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

/** IST calendar date (YYYY-MM-DD) — the budget bucket key. */
export function istDateString(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// ---------- persistence (audit + budget) ----------

async function auditRow(row: {
  role: AiRole;
  model: string;
  promptHash: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  outcome: AiOutcome;
  fallbackReason?: string;
  /** Only rows where the Gemini API was actually hit consume the daily quota. */
  counted?: boolean;
}): Promise<void> {
  try {
    const { db } = await import('../../db');
    await db.aiCall.create({
      data: { ...row, callDate: istDateString(), counted: row.counted ?? false },
    });
  } catch {
    // audit must never break the pipeline
  }
}

/** Real network attempts today — the only thing the budget protects (free-tier quota). */
export async function aiBudgetUsedToday(): Promise<number> {
  try {
    const { db } = await import('../../db');
    return await db.aiCall.count({ where: { callDate: istDateString(), counted: true } });
  } catch {
    return 0;
  }
}

// ---------- limiter + breaker ----------

const MAX_RPM = 8;
const TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 2_000;
const BREAKER_THRESHOLD = 2;
const BREAKER_OPEN_MS = 10 * 60_000;

/** Pace to ≤ 8 requests/min (below the ~10 RPM free-tier cap). */
async function limiterWait(): Promise<void> {
  for (;;) {
    const now = Date.now();
    mem.limiter = mem.limiter.filter((t) => now - t < 60_000);
    if (mem.limiter.length < MAX_RPM) {
      mem.limiter.push(now);
      return;
    }
    const waitMs = 60_000 - (now - mem.limiter[0]) + 50;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 8_000)));
  }
}

function breakerOpen(): boolean {
  return Date.now() < mem.breaker.openUntil;
}

function noteFailure(reason: string): void {
  mem.breaker.consecFailures += 1;
  if (mem.breaker.consecFailures >= BREAKER_THRESHOLD) {
    mem.breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    mem.breaker.reason = reason;
  }
}

function noteSuccess(): void {
  mem.breaker.consecFailures = 0;
  mem.breaker.openUntil = 0;
  mem.breaker.reason = undefined;
}

// ---------- the call ----------

export interface GeminiOptions<T> {
  role: AiRole;
  systemInstruction: string;
  prompt: string;
  /** zod schema — post-parse validation (defense in depth). */
  zod: z.ZodType<T>;
  /** native responseSchema for structured output (enums bound at the source). */
  responseSchema: Record<string, unknown>;
  timeoutMs?: number;
  /** skip the budget gate (probe calls are still audited). */
  countTowardsBudget?: boolean;
}

type GenerateContentFn = (args: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
}) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;

let testGenerate: GenerateContentFn | null = null;

/** Test seam: inject a mock generateContent (never used in production paths). */
export function __setGeminiGenerateForTests(fn: GenerateContentFn | null): void {
  testGenerate = fn;
}

/** Test seam: reset limiter/breaker/last-outcome state between tests. */
export function __resetGeminiForTests(): void {
  mem.limiter = [];
  mem.breaker = { openUntil: 0, consecFailures: 0, reason: undefined };
  mem.lastOutcome = null;
  mem.client = null;
}

async function realGenerate(args: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  const { GoogleGenAI } = await import('@google/genai');
  if (!mem.client) {
    mem.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }
  const ai = mem.client as import('@google/genai').GoogleGenAI;
  const res = await ai.models.generateContent({
    model: geminiModel(),
    contents: args.prompt,
    config: {
      systemInstruction: args.systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: args.responseSchema,
    },
  });
  const usage = (res as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
    .usageMetadata;
  return {
    text: (res as { text?: string }).text ?? '',
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
  };
}

function isRateOrServerError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b|rate\s*limit|too many requests|resource_exhausted|\b5\d\d\b|internal|unavailable|overloaded/i.test(
    msg
  );
}

/**
 * One structured Gemini call. Never throws. Order of gates:
 * nokey → breaker → budget → limiter → timeout-raced call (1 retry on
 * 429/5xx) → JSON parse → zod validation. Every path is audited.
 */
export async function geminiStructured<T>(opts: GeminiOptions<T>): Promise<AiCallResult<T>> {
  const t0 = Date.now();
  const model = geminiModel();
  const promptHash = sha256(opts.systemInstruction + '|' + opts.prompt);
  const base = { role: opts.role, model, promptHash };

  if (!process.env.GEMINI_API_KEY) {
    await auditRow({ ...base, latencyMs: 0, outcome: 'nokey', fallbackReason: 'GEMINI_API_KEY absent' });
    mem.lastOutcome = { outcome: 'nokey', at: Date.now(), reason: 'no key' };
    return { ok: false, outcome: 'nokey', reason: 'GEMINI_API_KEY absent', latencyMs: 0, model };
  }

  if (breakerOpen()) {
    await auditRow({
      ...base,
      latencyMs: 0,
      outcome: 'fallback',
      fallbackReason: `circuit open: ${mem.breaker.reason ?? 'recent failures'}`,
    });
    return {
      ok: false,
      outcome: 'fallback',
      reason: `circuit breaker open (${Math.ceil((mem.breaker.openUntil - Date.now()) / 60_000)} min left)`,
      latencyMs: 0,
      model,
    };
  }

  if (opts.countTowardsBudget !== false) {
    const used = await aiBudgetUsedToday();
    if (used >= aiBudgetLimit()) {
      await auditRow({
        ...base,
        latencyMs: 0,
        outcome: 'budget',
        fallbackReason: `daily budget ${used}/${aiBudgetLimit()} spent`,
      });
      mem.lastOutcome = { outcome: 'budget', at: Date.now(), reason: 'budget spent' };
      return {
        ok: false,
        outcome: 'budget',
        reason: `AI budget spent (${used}/${aiBudgetLimit()} today) — dictionary mode`,
        latencyMs: 0,
        model,
      };
    }
  }

  await limiterWait();
  const generate = testGenerate ?? realGenerate;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  const attempt = async (): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> => {
    return Promise.race([
      generate({ systemInstruction: opts.systemInstruction, prompt: opts.prompt, responseSchema: opts.responseSchema }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  };

  let raw = '';
  let tokens: { inputTokens?: number; outputTokens?: number } = {};
  try {
    try {
      const r = await attempt();
      raw = r.text;
      tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    } catch (first) {
      const msg = first instanceof Error ? first.message : String(first);
      if (/timeout/.test(msg)) throw first;
      if (!isRateOrServerError(msg)) throw first;
      // exactly one retry, with backoff
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      const r = await attempt();
      raw = r.text;
      tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const outcome: AiOutcome = /timeout/i.test(msg)
      ? 'timeout'
      : isRateOrServerError(msg)
        ? 'rate_limited'
        : 'fallback';
    noteFailure(msg);
    mem.lastOutcome = { outcome, at: Date.now(), reason: msg };
    await auditRow({
      ...base,
      latencyMs: Date.now() - t0,
      outcome,
      fallbackReason: msg.slice(0, 200),
      counted: true, // a real network attempt was made (and failed)
      ...tokens,
    });
    return { ok: false, outcome, reason: msg, latencyMs: Date.now() - t0, model };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    noteFailure('invalid JSON from model');
    mem.lastOutcome = { outcome: 'rejected', at: Date.now(), reason: 'invalid JSON' };
    await auditRow({
      ...base,
      latencyMs: Date.now() - t0,
      outcome: 'rejected',
      fallbackReason: 'invalid JSON from model',
      counted: true, // the call happened; the model returned non-JSON
      ...tokens,
    });
    return { ok: false, outcome: 'rejected', reason: 'invalid JSON from model', latencyMs: Date.now() - t0, model };
  }

  const zr = opts.zod.safeParse(parsed);
  if (!zr.success) {
    noteFailure('schema rejection');
    mem.lastOutcome = { outcome: 'rejected', at: Date.now(), reason: 'schema' };
    await auditRow({
      ...base,
      latencyMs: Date.now() - t0,
      outcome: 'rejected',
      fallbackReason: `zod: ${zr.error.issues[0]?.path.join('.')} ${zr.error.issues[0]?.message ?? ''}`,
      counted: true, // the call happened; the response failed validation
      ...tokens,
    });
    return {
      ok: false,
      outcome: 'rejected',
      reason: `schema rejection: ${zr.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      latencyMs: Date.now() - t0,
      model,
    };
  }

  noteSuccess();
  mem.lastOutcome = { outcome: 'ok', at: Date.now() };
  await auditRow({
    ...base,
    latencyMs: Date.now() - t0,
    outcome: 'ok',
    counted: true, // real call, real tokens
    ...tokens,
  });
  return { ok: true, outcome: 'ok', data: zr.data, latencyMs: Date.now() - t0, model };
}

// ---------- provider status (for /api/health + UI badge) ----------

export interface GeminiStatus {
  state: 'nokey' | 'ok' | 'fallback' | 'budget';
  model: string;
  breakerOpen: boolean;
  breakerReason?: string;
  lastOutcome?: { outcome: AiOutcome; at: number; reason?: string };
}

export function geminiStatusSync(): GeminiStatus {
  if (!process.env.GEMINI_API_KEY) return { state: 'nokey', model: geminiModel(), breakerOpen: false };
  const open = breakerOpen();
  const last = mem.lastOutcome;
  let state: GeminiStatus['state'] = 'ok';
  if (open) state = 'fallback';
  else if (last?.outcome === 'budget') state = 'budget';
  else if (last && last.outcome !== 'ok' && Date.now() - last.at < 5 * 60_000) state = 'fallback';
  return {
    state,
    model: geminiModel(),
    breakerOpen: open,
    breakerReason: mem.breaker.reason,
    lastOutcome: last ?? undefined,
  };
}

/** UI badge: GEMINI | DICT | AI BUDGET SPENT. */
export function providerBadge(status = geminiStatusSync()): 'GEMINI' | 'DICT' | 'AI BUDGET SPENT' {
  if (status.state === 'nokey') return 'DICT';
  if (status.state === 'budget') return 'AI BUDGET SPENT';
  if (status.state === 'fallback') return 'DICT';
  return 'GEMINI';
}
