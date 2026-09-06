#!/usr/bin/env node
/**
 * KAVACH — API truth check (diagnostics, not shipped to production).
 * Hits the SAME endpoints the app itself uses and grades them against the
 * sprint acceptance rules. Read-only: never mutates app state beyond what a
 * normal dashboard poll already does.
 *
 * Usage: node scripts/check-apis.mjs [baseUrl]   (default http://localhost:3000)
 *
 * Grades:
 *   PASS / WARN / FAIL / SKIP
 *   - Google News RSS  : must PASS (24x7)              -> FAIL if broken
 *   - GDELT            : PASS normal, WARN if rate-limited, FAIL if broken
 *   - Yahoo ^NSEI/USDINR/GC=F : PASS if a close is returned (weekend = last close)
 *   - Gemini           : SKIP if no key, PASS if keyed model answers
 *   - App health       : PASS if status ok + db ok + mode/status body
 *
 * Exit 0 = acceptable, 1 = FAIL lines present.
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';
const UA = 'KAVACH/2.0 (+educational research console)';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
try {
  const envPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../.env');
  const env = readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*(GEMINI_\w+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const results = [];

function grade(line, verdict, detail, meta = {}) {
  results.push({ verdict: verdict.toUpperCase(), detail, meta });
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', SKIP: 'SKIP' }[verdict.toUpperCase()] ?? verdict;
  const linePad = line.padEnd(22, ' ');
  const det = detail ? `  ${detail}` : '';
  console.log(`  ${linePad} ${icon}${det}`.trim());
}

async function get(url, extra = {}) {
  return fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(extra.headers ?? {}) },
    ...extra,
  });
}

async function checkHealth() {
  try {
    const res = await get(`${BASE}/api/kavach/health`);
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    const j = await res.json();
    let detail = `status=${j.status} db=${j.db} mode=${j.mode} market=${j.market?.session ?? 'n/a'} gemini=${j.gemini?.state} budget=${j.budget?.used}/${j.budget?.limit}`;
    if (j.dbError) detail += ` dbError=${j.dbError}`;
    const dbOk = j.status === 'ok' && j.db === 'ok';
    const modeOk = typeof j.mode === 'string' && j.mode.length > 0;
    grade('APP HEALTH', dbOk && modeOk ? 'PASS' : 'FAIL', detail);
    return j;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grade('APP HEALTH', 'FAIL', msg);
    return null;
  }
}

async function checkGoogleNews() {
  try {
    const q = encodeURIComponent('Indian stock market when:2d');
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await get(url, { headers: { Accept: 'application/xml,*/*' } });
    if (!res.ok) throw new Error(`googlenews HTTP ${res.status}`);
    const xml = await res.text();
    const items = (xml.match(/<item>/g) ?? []).length;
    const titles = [...xml.matchAll(/<title>(?!Google News)(.*?)<\/title>/gs)].map((m) => m[1].trim());
    const sample = titles[0] ? titles[0].slice(0, 90) : '(no titles)';
    if (items === 0) throw new Error('RSS returned 0 <item> entries');
    grade('GOOGLE NEWS RSS', 'PASS', `${items} items; sample: ${sample}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grade('GOOGLE NEWS RSS', 'FAIL', msg);
  }
}

async function checkGdelt() {
  const probe = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent('Indian markets economy')}&mode=artlist&maxrecords=10&format=json&timespan=3d`;
  try {
    const res = await get(probe, { signal: AbortSignal.timeout(20000) });
    if (res.status === 429) {
      grade('GDELT', 'WARN', 'HTTP 429 rate-limited (shared IP) — transitively tolerable, RSS is primary');
      return;
    }
    if (!res.ok) throw new Error(`gdelt HTTP ${res.status}`);
    const text = await res.text();
    if (/rate[- ]?limit/i.test(text) || /7800|etiquette|throttle/i.test(text)) {
      grade('GDELT', 'WARN', 'upstream rate-limit/throttle text (RSS is primary)');
      return;
    }
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('non-JSON body'); }
    const n = Array.isArray(j.articles) ? j.articles.length : 0;
    if (n === 0) throw new Error('0 articles in payload');
    grade('GDELT', 'PASS', `${n} articles`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grade('GDELT', 'FAIL', msg);
  }
}

async function checkYahoo(sym, label) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
    const res = await get(url);
    if (!res.ok) throw new Error(`yahoo HTTP ${res.status} for ${sym}`);
    const j = await res.json();
    const close = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const asOf = j?.chart?.result?.[0]?.meta?.regularMarketTime;
    if (typeof close !== 'number' || !Number.isFinite(close)) throw new Error('no regularMarketPrice');
    const when = asOf ? new Date(asOf * 1000).toISOString() : new Date().toISOString();
    grade(label, 'PASS', `close=${close} asOf=${when}${asOf ? ` (${new Date(asOf * 1000).toISOString().slice(0,10)})` : ''}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grade(label, 'FAIL', msg);
  }
}

async function checkGemini(model) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    grade('GEMINI', 'SKIP', '(no key yet — expected in first run)');
    return;
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK' }] }] }),
    });
    const body = await res.text();
    if (!res.ok) {
      grade('GEMINI', 'FAIL', `HTTP ${res.status}: ${body.slice(0, 400)}`);
      return;
    }
    let j; try { j = JSON.parse(body); } catch { j = null; }
    const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const ok = /ok/i.test(txt);
    grade('GEMINI', ok ? 'PASS' : 'FAIL', `model=${model} reply="${txt.slice(0,60)}"`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    grade('GEMINI', 'FAIL', `network ${msg}`);
  }
}

(async () => {
  console.log(`\nKAVACH API TRUTH CHECK — base ${BASE}  (${new Date().toISOString()})\n`);
  const health = await checkHealth();
  await checkGoogleNews();
  await checkGdelt();
  await checkYahoo('^NSEI', 'YAHOO ^NSEI');
  await checkYahoo('USDINR=X', 'YAHOO USDINR');
  await checkYahoo('GC=F', 'YAHOO GC=F');
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  await checkGemini(model);

  const fails = results.filter((r) => r.verdict === 'FAIL');
  const warns = results.filter((r) => r.verdict === 'WARN');
  const skips = results.filter((r) => r.verdict === 'SKIP');
  const passes = results.filter((r) => r.verdict === 'PASS');
  console.log(`\nSUMMARY: ${passes.length} PASS / ${warns.length} WARN / ${skips.length} SKIP / ${fails.length} FAIL`);
  if (health && health.apiKeyWarning) console.log('NOTE:', health.apiKeyWarning);
  console.log(`EXIT CODE expected: ${fails.length === 0 ? '0 (acceptable)' : '1 (investigate FAILs)'}`);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('DIAG ABORTED:', e);
  process.exit(2);
});