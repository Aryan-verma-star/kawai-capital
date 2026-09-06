'use client';

/**
 * KAVACH — the console (single route).
 *
 * Two modes over one codebase, one recorder, one constitution:
 *  REPLAY LAB  — three deterministic Indian crisis A/B replays (seed 42).
 *  LIVE PAPER  — the ₹1,000 Cr book marked to real Yahoo prices and real
 *               news, Gemini perception (Advisor + Critic in the loop at
 *               zero authority), durable approvals, hash-chained recorder.
 *
 * Design contract ("a calm quant desk terminal"): near-black background,
 * hairline borders, ONE amber accent for AI moments, semantic color only
 * where money moves, mono tabular numerals, tables where data is tabular,
 * AI content in context (inside the trade table, beside its headline) —
 * never floating confetti. Educational simulation; no real orders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivitySquare,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Ban,
  ChevronRight,
  CircleDot,
  Clock,
  Command,
  Download,
  FileClock,
  FlaskConical,
  Gauge,
  Landmark,
  Link2,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Scale,
  ScrollText,
  Shield,
  ShieldAlert,
  Sparkles,
  Square,
  StepForward,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { BUCKETS, type BucketId } from '@/lib/kavach/types';
import { fmt_inr } from '@/lib/kavach/format';

// ---------------------------------------------------------------- types (API shapes, client-local)

interface ApprovalCard {
  id: string;
  day: number;
  deadlineDay: number;
  trade: { bucket: BucketId; value: number; direction: 1 | -1; participation: number };
  regime: string;
  articlesInvoked: string[];
  counterfactual: { cvarIfRejected: number; liquidityHorizonIfRejected: number; forcedSaleRisk: string; note: string };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT';
  decidedBy?: string;
}

interface RadarEvent {
  day: number;
  headline: string;
  event: string;
  severity: number;
  buckets: string[];
  direction: string;
  confidence: number;
  source: string;
  provider: string;
  applied: boolean;
  latencyMs?: number;
}

/** GET /api/kavach/live/stress — what-if pre-mortem on the LIVE book. */
interface StressLensView {
  scenario: string;
  title: string;
  story: string;
  days: number;
  path: { day: number; nav: number; dd: number }[];
  navStartCr: number;
  navEndCr: number;
  maxDrawdown: number;
  worstDay: number;
  cvar95: number;
  sleeveCum: Record<string, number>;
  worstSleeve: { bucket: string; ret: number } | null;
  verdicts: { article: string; title: string; passed: boolean; breachDay: number | null; detail: string }[];
  honest: string;
}

interface Check {
  article: string;
  title: string;
  passed: boolean;
  detail: string;
  breached?: boolean;
}

/** One executed paper trade, as read back from the recorder (the blotter). */
interface LiveTradeView {
  seq: number;
  day: number;
  kind: 'EXECUTION' | 'FORCED_SALE';
  bucket: string;
  dir: 1 | -1;
  valueCr: number;
  participation: number;
  impactCostCr: number;
  reason: string;
  origin: 'optimizer' | 'ai_advisor' | 'human' | 'forced';
  reClipped?: boolean;
}

interface BotSnapshot {
  mode: string;
  day: number;
  nav: number;
  drawdown: number;
  maxDrawdown: number;
  values: Record<string, number>;
  weights: Record<string, number>;
  prices: Record<string, number>;
  cash: number;
  borrowings: number;
  postedMtf: number;
  postedCcil: number;
  gross: number;
  bucketStats: { bucket: string; price: number; units: number; value: number; ret1d: number; ewmaVol: number }[];
  ewmaPortfolioVolAnn: number;
  volRatio: number;
  cvar95: number;
  cvarLimit: number;
  liquidityDays: number;
  regime: string;
  navSeries: { day: number; nav: number; dd: number }[];
  marginCumulative: number;
  impactPaid: number;
  forcedSaleEvents: number;
  redemptionsMissed: number;
  maxParticipation: number;
  participationBreaches: number;
  cascadeDays: number;
  constitution: Check[];
  approvals: ApprovalCard[];
  radarFeed: RadarEvent[];
  articleFired: { day: number; article: string; detail: string }[];
}

interface ReplayState {
  active: boolean;
  scenario: { id: string; title: string; story: string; days: number };
  day: number;
  complete: boolean;
  mode: string;
  seed: number;
  autonomy: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE';
  llmRadar: boolean;
  fx: number;
  yieldLevel: number;
  headline: { day: number; text: string } | null;
  headlines: { day: number; text: string }[];
  bots: Partial<Record<'naive' | 'governed', BotSnapshot>>;
  postMortem: { markdown: string; provider: string; latencyMs: number } | null;
  recorderSize: { naive: number; governed: number };
  recorderHead: { naive: string; governed: string };
  abHeadline: string | null;
  governedPnlStr: string | null;
  naivePnlStr: string | null;
}

interface LiveState {
  sessionId: string;
  day: number;
  nav: number;
  navStart: number;
  navSeries: { day: number; nav: number; dd: number }[];
  regime: string;
  autonomy: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE';
  market: { open: boolean; session: string; istDate: string; istTime: string; reason: string };
  book: {
    values: Record<string, number>;
    weights: Record<string, number>;
    prices: Record<string, number>;
    cash: number;
    borrowings: number;
    postedMtf: number;
    postedCcil: number;
    gross: number;
    markSource: Record<string, string>;
    marginCumulative: number;
    impactPaid: number;
    forcedSaleEvents: number;
    maxParticipation: number;
  };
  risk: {
    cvar95: number;
    cvarLimit: number;
    ewmaPortfolioVolAnn: number;
    volRatio: number;
    liquidityDays: number;
    drawdown: number;
    maxDrawdown: number;
    grossCap: number;
  };
  bucketPerf: Record<string, number[]>;
  trades: LiveTradeView[];
  real: { eq: number; usdinr: number; goldInr: number; asOf: string; stale: boolean } | null;
  providers: {
    gemini: { state: string; model: string; breakerOpen: boolean };
    badge: string;
    news: { degraded: boolean; articles: number; lastFetch: number | null };
    price: { state: string; lastFetch: number | null; lastError?: string; asOf?: string };
    budget: { used: number; limit: number };
  };
  radar: RadarEvent[];
  radarLog: {
    day: number;
    headline: string;
    reading: { event: string; severity: number; buckets: string[]; direction: string; confidence: number; sourceUrl?: string };
    provider: string;
    applied: boolean;
    rejectedByA7: boolean;
  }[];
  approvals: ApprovalCard[];
  constitution: Check[];
  ai: {
    advisor: { day: number; bucket: string; action: string; valueCr: number; note: string }[];
    critic: { day: number; verdict: string; concern: string }[];
    lastAdvisorOutcome: string | null;
    lastCriticOutcome: string | null;
  };
  recorder: { entries: number; headHash: string; chainValid: boolean };
  lastRebalanceDay: number | null;
  lastRadarAt: number | null;
  status: string;
  disclaimer: string;
}

// ---------------------------------------------------------------- constants

const CR = 1e7;

const SCENARIOS: { id: string; key: string; title: string; story: string; days: number; tag: string }[] = [
  {
    id: 'TANTRUM-13',
    key: '1',
    title: 'Taper Tantrum 2013',
    story: 'The Fed signals taper; FPIs flee, the rupee hits a lifetime low, gilts sell off. Gold rallies in INR.',
    days: 30,
    tag: 'RATES + FX SHOCK',
  },
  {
    id: 'ILFS-18',
    key: '2',
    title: 'IL&FS 2018',
    story: 'A ₹91,000 Cr default freezes NBFC funding; debt funds face cascading redemptions into vanished liquidity.',
    days: 45,
    tag: 'CREDIT FREEZE',
  },
  {
    id: 'COVID-20',
    key: '3',
    title: 'COVID 2020',
    story: 'The dash-for-cash: everything sells to meet margins, gold included, until the RBI\'s day-14 LTRO/OMO backstop.',
    days: 30,
    tag: 'LIQUIDITY SQUEEZE',
  },
];

const BUCKET_LABEL: Record<string, string> = {
  EQ: 'NIFTY 50 Equity',
  GSEC: 'G-Sec 10Y',
  IGCORP: 'IG Corporate',
  CRED: 'A-rated Credit',
  GOLD: 'Gold (INR)',
  LIQ: 'TREPS Liquid',
};

const REGIME_TONE: Record<string, string> = {
  CALM: 'text-zinc-300',
  STRESSED: 'text-amber-300',
  CRISIS: 'text-red-400',
  RECOVERY: 'text-emerald-400',
};

// ---------------------------------------------------------------- small utilities

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && res.status !== 404) {
    throw Object.assign(new Error((data as { error?: string }).error ?? res.statusText), { data });
  }
  return data;
}

const cr = (x: number, dp = 2) => `₹${(x / CR).toFixed(dp)} Cr`;
const pct = (x: number, dp = 2) => `${(x * 100).toFixed(dp)}%`;
const sign = (x: number, dp = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}`;
const tone = (x: number) => (x >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]');
const hhmmss = (t: number) => new Date(t).toLocaleTimeString('en-IN', { hour12: false });

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between pb-2">
      <span className="section-label">{children}</span>
      {right ? <span className="text-[11px] text-zinc-600">{right}</span> : null}
    </div>
  );
}

function ProviderChip({ badge }: { badge: string }) {
  const isGemini = badge === 'GEMINI';
  const isBudget = badge === 'AI BUDGET SPENT';
  return (
    <span
      className={`num inline-flex items-center gap-1 border px-1.5 py-px text-[10px] leading-4 tracking-wide ${
        isGemini
          ? 'border-[#3a2d14] bg-[#1c1710] text-[#f5c069]'
          : isBudget
            ? 'border-[#4a1f1f] bg-[#1c1112] text-[#f5a623]'
            : 'border-[#26262b] bg-[#131317] text-zinc-400'
      }`}
      title={
        isGemini
          ? 'Gemini is live for perception (radar/advisor/critic) — zero authority'
          : isBudget
            ? 'Daily AI budget spent — deterministic dictionary active (A9)'
            : 'Deterministic dictionary mode (no key or fallback) — A9 fail-safe'
      }
    >
      {isGemini ? <Sparkles size={10} strokeWidth={1.5} /> : isBudget ? <Ban size={10} strokeWidth={1.5} /> : <Shield size={10} strokeWidth={1.5} />}
      {badge}
    </span>
  );
}

function SeverityChip({ sev }: { sev: number }) {
  const label = sev >= 4 ? 'border-[#4a1f1f] text-[#f08a8a]' : sev === 3 ? 'border-[#3a2d14] text-[#f5c069]' : 'border-[#26262b] text-zinc-500';
  return <span className={`num border px-1 py-px text-[10px] leading-4 ${label}`}>SEV {sev}</span>;
}

/** Client-side file download (post-mortem .md etc.). */
function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Next NSE open, computed from the IST wall clock the server reported. */
function nextOpenLabel(istDate: string, istTime: string): string {
  const [y, m, d] = istDate.split('-').map(Number);
  const [hh, mm] = istTime.split(':').map(Number);
  const now = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const open = new Date(now);
  open.setUTCHours(9, 15, 0, 0);
  let t = open.getTime() <= now.getTime() ? open.getTime() + 86_400_000 : open.getTime();
  while ([0, 6].includes(new Date(t).getUTCDay())) t += 86_400_000;
  const diff = t - now.getTime();
  const hrs = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  const span = hrs >= 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const dayName = new Date(t).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
  return `${dayName} 09:15 IST · in ${span}`;
}

/** Tiny sleeve-performance sparkline (day 0 = 100). 64×18 px, no library. */
function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return <span className="num text-[10px] text-zinc-600">—</span>;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const W = 64;
  const H = 18;
  const pts = series
    .map((v, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`)
    .join(' ');
  const up = series[series.length - 1] >= series[0];
  const last = series[series.length - 1];
  const lastY = H - 2 - ((last - min) / span) * (H - 4);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden focusable="false">
      <polyline points={pts} fill="none" stroke={up ? '#10B981' : '#EF4444'} strokeWidth={1} />
      <circle cx={W} cy={lastY} r={1.5} fill={up ? '#10B981' : '#EF4444'} />
    </svg>
  );
}

/** One hairline budget bar: label · track · tabular readout.
 *  mode 'toward'   — fill = progress toward a bad threshold (CVaR, gross, ADV, |DD|)
 *  mode 'coverage' — fill = coverage of a minimum (LIQ floor); a low fill is the warning
 *  Color only where money moves: zinc normally, amber near the edge, red past it. */
function StatBar({
  label,
  valueStr,
  value,
  limit,
  mode,
}: {
  label: string;
  valueStr: string;
  value: number;
  limit: number;
  mode: 'toward' | 'coverage';
}) {
  const ratio = value / (limit || 1e-9);
  const frac = Math.max(0, Math.min(1, Math.abs(ratio)));
  const bad = mode === 'toward' ? Math.abs(ratio) > 1 : Math.abs(ratio) < 1;
  const warn = mode === 'toward' ? Math.abs(ratio) >= 0.85 : Math.abs(ratio) <= 1.15;
  const fill = bad ? '#EF4444' : warn ? '#F5A623' : '#3F3F46';
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-[86px] shrink-0 text-[11px] text-zinc-500">{label}</span>
      <span className="relative h-[3px] min-w-0 flex-1 bg-[#1F1F23]">
        <span className="absolute inset-y-0 left-0 transition-[width] duration-150" style={{ width: `${frac * 100}%`, background: fill }} />
      </span>
      <span className={`num w-[120px] shrink-0 text-right text-[11px] ${bad ? 'text-[#EF4444]' : 'text-zinc-300'}`}>{valueStr}</span>
    </div>
  );
}

/** The desk's risk budget: three bars, same caps the optimizer is held to. */
function RiskBudgetStrip({ live }: { live: LiveState }) {
  const liqW = (live.book.values['LIQ'] ?? 0) / Math.max(live.nav, 1);
  return (
    <div className="space-y-1.5">
      <StatBar label="CVaR 95 / limit" valueStr={`${pct(live.risk.cvar95, 1)} / ${pct(live.risk.cvarLimit, 1)}`} value={live.risk.cvar95} limit={live.risk.cvarLimit} mode="toward" />
      <StatBar label="Gross / regime cap" valueStr={`${(live.book.gross / live.nav).toFixed(2)}× / ${live.risk.grossCap.toFixed(2)}×`} value={live.book.gross / live.nav} limit={live.risk.grossCap} mode="toward" />
      <StatBar label="LIQ weight / floor" valueStr={`${pct(liqW, 1)} / 5.0%`} value={liqW} limit={0.05} mode="coverage" />
    </div>
  );
}

/** Replay-mode risk budget (governed bot): CVaR, A3 participation, drawdown. */
function ReplayRiskStrip({ g }: { g: BotSnapshot }) {
  return (
    <div className="space-y-1.5">
      <StatBar label="CVaR 95 / limit" valueStr={`${pct(g.cvar95, 1)} / ${pct(g.cvarLimit, 1)}`} value={g.cvar95} limit={g.cvarLimit} mode="toward" />
      <StatBar label="Peak ADV / A3 cap" valueStr={`${pct(g.maxParticipation, 1)} / 10.0%`} value={g.maxParticipation} limit={0.1} mode="toward" />
      <StatBar label="Max DD / desk stop" valueStr={`${pct(g.maxDrawdown, 1)} / −10.0%`} value={Math.abs(g.maxDrawdown)} limit={0.1} mode="toward" />
    </div>
  );
}

const ORIGIN_LABEL: Record<LiveTradeView['origin'], { text: string; cls: string; title: string }> = {
  optimizer: { text: 'OPT', cls: 'border-[#26262b] text-zinc-400', title: 'Deterministic optimizer intent, constitution-gated' },
  ai_advisor: { text: 'AI', cls: 'border-[#3a2d14] bg-[#1c1710] text-[#f5c069]', title: 'Gemini Advisor proposal that survived the constitution clip and merge — zero authority beyond any other trade' },
  human: { text: 'HUMAN', cls: 'border-[#1f3a2a] text-[#10B981]', title: 'Executed on a human consent-card approval, re-clipped to A3 at execution time' },
  forced: { text: 'FORCED', cls: 'border-[#4a1f1f] text-[#f08a8a]', title: 'Margin-driven forced sale (lender enforcement) — the state the constitution exists to avoid' },
};

/** Session blotter — every executed paper trade, read back from the recorder. */
function TradeBlotter({ trades }: { trades: LiveTradeView[] }) {
  const totalImpact = trades.reduce((a, t) => a + t.impactCostCr, 0);
  return (
    <div>
      <SectionLabel right={trades.length ? `${trades.length} legs · impact ₹${totalImpact.toFixed(2)} Cr` : 'no legs'}>Session blotter — executed paper trades</SectionLabel>
      {trades.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={14} strokeWidth={1.5} />}
          text={<span>No paper trades yet. When a rebalance fires, every executed leg lands here — with its origin (optimizer · AI · human · forced), A3 participation and impact cost — straight from the hash-chained recorder.</span>}
        />
      ) : (
        <div className="max-h-64 overflow-y-auto scrollbar-terminal">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[#101013]">
              <tr className="hairline-b text-left">
                {['d', 'Sleeve', '', '₹ Cr', '% ADV', 'Impact', 'Origin'].map((h, i) => (
                  <th key={h + i} className={`pb-1.5 pr-2 font-medium text-zinc-500 ${i >= 3 ? 'text-right' : ''} ${i === 0 ? 'w-9' : ''} ${i === 1 ? 'w-[30%]' : ''} ${i === 2 ? 'w-14' : ''} ${i === 6 ? 'w-20' : ''}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades
                .slice()
                .reverse()
                .map((t) => {
                  const o = ORIGIN_LABEL[t.origin];
                  return (
                    <tr
                      key={t.seq}
                      className={`hairline-b transition-colors duration-150 hover:bg-[#131317] ${t.origin === 'ai_advisor' ? 'border-l-2 border-[#F5A623]' : t.origin === 'forced' ? 'border-l-2 border-[#EF4444]' : 'border-l-2 border-transparent'}`}
                      title={t.reason}
                    >
                      <td className="num py-1.5 pr-2 text-zinc-500">{t.day}</td>
                      <td className="py-1.5 pr-2">
                        <span className="num text-zinc-300">{t.bucket}</span>
                        {t.reClipped ? <span className="num ml-1.5 border border-[#3a2d14] px-1 py-px text-[9px] leading-3 text-[#f5c069]" title="Re-clipped to A3 at execution time — ADV moved between proposal and approval">RE-CLIP</span> : null}
                      </td>
                      <td className={`num py-1.5 pr-2 text-[11px] ${t.dir === 1 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>{t.dir === 1 ? 'BUY' : 'SELL'}</td>
                      <td className="num py-1.5 pr-2 text-right text-zinc-100">{t.valueCr.toFixed(2)}</td>
                      <td className="num py-1.5 pr-2 text-right text-zinc-400">{(t.participation * 100).toFixed(1)}</td>
                      <td className="num py-1.5 pr-2 text-right text-zinc-500">{t.impactCostCr > 0 ? t.impactCostCr.toFixed(3) : '—'}</td>
                      <td className="py-1.5 pr-2 text-right">
                        <span className={`num inline-block border px-1 py-px text-[9px] leading-3 ${o.cls}`} title={o.title}>
                          {o.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Durable session history (SQLite) — proof the book survives restarts. */
interface SessionRow {
  id: string;
  day: number;
  navCr: number | null;
  status: string;
  headHash: string | null;
  current: boolean;
  openedAt: string;
}
function SessionHistory({ currentId, refreshKey }: { currentId: string; refreshKey: number }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api<{ sessions: SessionRow[] }>('/api/kavach/live/sessions');
        if (!cancelled) setRows(d.sessions);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return (
    <div className="border border-[#1F1F23] bg-[#101013] p-3">
      <SectionLabel right={rows ? `${rows.length} durable` : '…'}>Session history · SQLite</SectionLabel>
      <div className="max-h-44 space-y-1 overflow-y-auto pr-1 scrollbar-terminal">
        {rows === null ? (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" style={{ animationDuration: '1.2s' }} /> reading sessions…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Landmark size={14} strokeWidth={1.5} />} text={<span>No sessions yet — they persist across restarts in SQLite.</span>} />
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className={`flex items-baseline justify-between border px-2 py-1 text-[11px] ${
                r.id === currentId ? 'edge-active border-[#3a2d14] bg-[#1c1710]' : 'border-[#161619]'
              }`}
              title={r.headHash ? `chain head ${r.headHash}…` : 'no chain head recorded'}
            >
              <span className={`num ${r.id === currentId ? 'text-[#f5c069]' : 'text-zinc-400'}`}>
                {r.id.slice(0, 10)} · d{r.day} · {r.status}
              </span>
              <span className="num text-zinc-500">{r.navCr != null ? `₹${r.navCr.toFixed(1)} Cr` : '—'}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- charts

/** A palette command: id, label, optional kbd hint, group, action. */
interface Cmd {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/** The ⌘K command palette — a quant desk's keyboard. Filter + arrows + Enter.
 *  Mounted only while open, so every open starts with a clean query. */
function CommandPalette({ onClose, commands }: { onClose: () => void; commands: Cmd[] }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => `${c.group} ${c.label} ${c.hint ?? ''}`.toLowerCase().includes(needle));
  }, [q, commands]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = filtered[sel];
        if (c) {
          onClose();
          c.run();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filtered, sel, onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} role="presentation">
      <div
        className="palette-in fixed left-1/2 top-[12%] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 border border-[#1F1F23] bg-[#101013] shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
        role="dialog"
        aria-modal="true"
        aria-label="command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#1F1F23] px-3 py-2">
          <Zap size={13} strokeWidth={1.5} className="text-[#F5A623]" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="run a command… (crisis, replay, export, live)"
            className="num min-w-0 flex-1 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
            aria-label="search commands"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto scrollbar-terminal">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-zinc-500">No command matches “{q}”.</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 ${
                  i === sel ? 'bg-[#1c1710] text-[#f5c069]' : 'text-zinc-300 hover:bg-[#131317]'
                } ${i === sel ? 'edge-active' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  onClose();
                  c.run();
                }}
              >
                <span className="num w-[74px] shrink-0 text-[9px] uppercase tracking-wider text-zinc-600">{c.group}</span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{c.label}</span>
                {c.hint ? <kbd className="kbd shrink-0">{c.hint}</kbd> : null}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-[#1F1F23] px-3 py-1.5 text-[9px] text-zinc-600">
          <span className="flex items-center gap-1"><kbd className="kbd">↑↓</kbd> move</span>
          <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> run</span>
          <span className="flex items-center gap-1"><kbd className="kbd">esc</kbd> close</span>
          <span className="num ml-auto">every action is recorded in the flight recorder</span>
        </div>
      </div>
    </div>
  );
}

const GRID = { stroke: '#27272A', strokeDasharray: '2 4' } as const;

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; dataKey?: string; value?: number; color?: string }[]; label?: string | number }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="border border-[#1F1F23] bg-[#131317] px-2.5 py-1.5 text-[11px] shadow-none">
      <div className="section-label mb-1">DAY {String(label ?? '')}</div>
      {payload.map((p, i) => (
        <div key={i} className="num flex items-center justify-between gap-4 text-zinc-300">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="tabular-nums">{p.value != null ? `₹${(p.value / CR).toFixed(2)} Cr` : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function DDTooltip({ active, payload, label }: { active?: boolean; payload?: { value?: number }[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="num border border-[#1F1F23] bg-[#131317] px-2.5 py-1 text-[11px] text-zinc-300">
      DAY {String(label ?? '')} · DD {pct(payload[0].value ?? 0, 1)}
    </div>
  );
}

interface Marker {
  day: number;
  nav: number;
  kind: 'radar' | 'margin' | 'rbi';
  label: string;
}

/** Terminal end-dot: a 2.5px marker on the LAST point only (r=0 elsewhere). */
function endDotFactory(len: number, color: string) {
  return (props: { cx?: number; cy?: number; index?: number }) => (
    <circle key={`end-${props.index}`} cx={props.cx ?? 0} cy={props.cy ?? 0} r={props.index === len - 1 ? 2.5 : 0} fill={color} stroke="#09090B" strokeWidth={1} />
  );
}

function ABNavChart({ naive, governed, markers }: { naive?: BotSnapshot; governed?: BotSnapshot; markers: Marker[] }) {
  const series = useMemo(() => {
    const days = Math.max(naive?.navSeries.length ?? 0, governed?.navSeries.length ?? 0, 1);
    const at = (arr: { day: number; nav: number }[] | undefined, d: number) =>
      arr?.find((p) => p.day === d)?.nav;
    const out: { day: number; naive?: number; governed?: number }[] = [];
    for (let d = 0; d < days; d++) {
      out.push({ day: d, naive: at(naive?.navSeries, d), governed: at(governed?.navSeries, d) });
    }
    return out;
  }, [naive, governed]);
  const navAt = (d: number) => governed?.navSeries.find((p) => p.day === d)?.nav ?? naive?.navSeries.find((p) => p.day === d)?.nav;

  return (
    <div className="crossfade h-[268px] w-full" data-testid="ab-chart">
      <ResponsiveContainer>
        <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal vertical={false} {...GRID} />
          <XAxis dataKey="day" tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }} tickLine={false} axisLine={{ stroke: '#1F1F23' }} minTickGap={24} />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
            tickLine={false}
            axisLine={false}
            width={62}
            minTickGap={12}
            tickFormatter={(v: number) => `${(v / CR).toFixed(0)}Cr`}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2A2A30', strokeWidth: 1 }} />
          {markers.map((m, i) => {
            const y = navAt(m.day);
            if (y == null) return null;
            const color = m.kind === 'margin' ? '#EF4444' : m.kind === 'radar' ? '#F5A623' : '#10B981';
            return (
              <ReferenceDot
                key={`${m.kind}-${m.day}-${i}`}
                x={m.day}
                y={y}
                r={3}
                fill={color}
                stroke="#09090B"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            );
          })}
          <Line type="monotone" dataKey="naive" name="NaiveBot" stroke="#EF4444" strokeWidth={1.5} strokeDasharray="5 4" dot={endDotFactory(series.length, '#EF4444')} isAnimationActive={false} />
          <Line type="monotone" dataKey="governed" name="KAVACH" stroke="#F5F5F5" strokeWidth={1.5} dot={endDotFactory(series.length, '#F5F5F5')} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function DrawdownStrip({ series }: { series: { day: number; dd: number }[] }) {
  if (series.length < 2) {
    return <div className="flex h-[56px] items-center justify-center text-[11px] text-zinc-600">drawdown appears after the first day</div>;
  }
  return (
    <div className="h-[56px] w-full">
      <ResponsiveContainer>
        <AreaChart data={series} margin={{ top: 2, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal vertical={false} {...GRID} />
          <XAxis dataKey="day" hide />
          <YAxis hide domain={['auto', 0]} />
          <Tooltip content={<DDTooltip />} />
          <Area type="monotone" dataKey="dd" stroke="#EF4444" strokeWidth={1} fill="#EF4444" fillOpacity={0.08} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function LiveNavChart({ series, rebalanceDay }: { series: { day: number; nav: number; dd: number }[]; rebalanceDay: number | null }) {
  const data = series.length > 1 ? series : [...series, { day: 0, nav: series[0]?.nav ?? 0, dd: 0 }];
  const startNav = data[0]?.nav ?? 0;
  return (
    <div className="crossfade h-[268px] w-full" data-testid="live-chart">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal vertical={false} {...GRID} />
          <XAxis dataKey="day" tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }} tickLine={false} axisLine={{ stroke: '#1F1F23' }} minTickGap={24} />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
            tickLine={false}
            axisLine={false}
            width={62}
            minTickGap={12}
            tickFormatter={(v: number) => `${(v / CR).toFixed(0)}Cr`}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2A2A30', strokeWidth: 1 }} />
          <ReferenceLine y={startNav} stroke="#2A2A30" strokeDasharray="2 4" ifOverflow="extendDomain" label={{ value: 'day-0 NAV', fill: '#52525B', fontSize: 9, fontFamily: 'var(--font-geist-mono)', position: 'insideTopRight' }} />
          {rebalanceDay != null && data.some((d) => d.day === rebalanceDay) ? (
            <ReferenceDot
              x={rebalanceDay}
              y={data.find((d) => d.day === rebalanceDay)?.nav ?? 0}
              r={3}
              fill="#F5A623"
              stroke="#09090B"
              ifOverflow="extendDomain"
            />
          ) : null}
          <Line type="monotone" dataKey="nav" name="LIVE NAV" stroke="#F5F5F5" strokeWidth={1.5} dot={endDotFactory(data.length, '#F5F5F5')} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- panels

function BookTable({
  values,
  prices,
  rets,
  markSource,
  advDays,
  perf,
}: {
  values: Record<string, number>;
  prices: Record<string, number>;
  rets?: Record<string, number>;
  markSource?: Record<string, string>;
  advDays?: Record<string, number>;
  /** cumulative sleeve performance since start (day 0 = 100) — LIVE only */
  perf?: Record<string, number[]>;
}) {
  const total = BUCKETS.reduce((a, b) => a + (values[b] ?? 0), 0);
  return (
    <table className="w-full table-fixed border-collapse text-[13px]">
      <thead>
        <tr className="hairline-b text-left">
          {[perf ? 'Sleeve' : 'Sleeve', 'Mark', '₹ Cr', '% Gross', '1d', ...(perf ? ['Trend'] : []), 'Liq days'].map((h, i) => (
            <th
              key={h + i}
              className={`pb-1.5 pr-3 font-medium text-zinc-500 ${i >= 1 ? 'text-right' : ''} ${i === 0 ? 'w-[30%]' : ''}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {BUCKETS.map((b) => {
          const v = values[b] ?? 0;
          const ret = rets?.[b];
          const ms = markSource?.[b];
          const series = perf?.[b];
          const perfRet = series && series.length > 1 ? series[series.length - 1] / series[0] - 1 : null;
          return (
            <tr key={b} className="hairline-b transition-colors duration-150 hover:bg-[#131317]">
              <td className="py-1.5 pr-3">
                <div className="flex items-center gap-2">
                  <span className="num text-zinc-200">{b}</span>
                  <span className="truncate text-[11px] text-zinc-600">{BUCKET_LABEL[b]}</span>
                  {ms === 'MARK-TO-MODEL' ? (
                    <span className="num shrink-0 border border-[#26262b] px-1 py-px text-[9px] leading-3 text-zinc-500" title="No free Indian bond ticker — this sleeve is marked to a news-driven yield/spread factor model. The honest label is a feature.">
                      MTM
                    </span>
                  ) : ms === 'REAL' ? (
                    <span className="num shrink-0 border border-[#1f3a2a] px-1 py-px text-[9px] leading-3 text-[#10B981]" title="Marked to a real market close (Yahoo Finance).">
                      REAL
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="num py-1.5 pr-3 text-right text-zinc-400">
                {prices[b] >= 10000 ? prices[b].toLocaleString('en-IN', { maximumFractionDigits: 0 }) : prices[b].toFixed(2)}
              </td>
              <td className="num py-1.5 pr-3 text-right text-zinc-100">{(v / CR).toFixed(2)}</td>
              <td className="num py-1.5 pr-3 text-right text-zinc-400">{total > 0 ? pct(v / total, 1) : '—'}</td>
              <td className={`num py-1.5 pr-3 text-right ${ret == null ? 'text-zinc-600' : tone(ret)}`}>{ret == null ? '—' : sign(ret * 100, 2) + '%'}</td>
              {perf ? (
                <td className="py-1.5 pr-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {perfRet != null ? <span className={`num text-[11px] ${tone(perfRet)}`}>{sign(perfRet * 100, 1)}%</span> : null}
                    <Spark series={series ?? []} />
                  </div>
                </td>
              ) : null}
              <td className="num py-1.5 pr-3 text-right text-zinc-500">{advDays?.[b] != null ? advDays[b].toFixed(1) : '0.0'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ApprovalsInbox({ cards, onDecide, busy }: { cards: ApprovalCard[]; onDecide: (id: string, d: 'APPROVED' | 'REJECTED') => void; busy?: boolean }) {
  const pending = cards.filter((c) => c.status === 'PENDING');
  const recent = cards.filter((c) => c.status !== 'PENDING').slice(-4).reverse();
  return (
    <div>
      <SectionLabel right={`${pending.length} open`}>Consent inbox · A8</SectionLabel>
      <div className="max-h-96 space-y-2 overflow-y-auto pr-1 scrollbar-terminal">
        {pending.length === 0 && recent.length === 0 ? (
          <EmptyState
            icon={<Scale size={14} strokeWidth={1.5} />}
            text={
              <span>
                No approval requests. The constitution’s hard limits let the agent act alone within
                <span className="text-zinc-300"> A1–A9</span>; humans are asked only when it matters.
              </span>
            }
          />
        ) : null}
        {pending.map((c) => (
          <div key={c.id} className="border border-[#1F1F23] bg-[#101013] p-3">
            <div className="flex items-center justify-between text-[11px] text-zinc-500">
              <span className="num">
                {c.id} · DAY {c.day} · {c.regime}
              </span>
              <span className="num">deadline d+{c.deadlineDay - c.day}</span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between">
              <span className="text-[13px] text-zinc-100">
                {c.trade.direction === -1 ? 'SELL' : 'BUY'} <span className="num">{c.trade.bucket}</span>
              </span>
              <span className="num text-[13px] text-zinc-100">{cr(c.trade.value)}</span>
            </div>
            <div className="num mt-0.5 text-[11px] text-zinc-500">
              {(c.trade.participation * 100).toFixed(1)}% of ADV · articles {c.articlesInvoked.join(' · ')}
            </div>
            <div className="mt-2 border-l-2 border-[#26262b] pl-2.5 text-[11px] leading-relaxed text-zinc-400">
              <span className="section-label">Counterfactual if rejected</span>
              <div className="num mt-1 text-zinc-300">
                CVaR {pct(c.counterfactual.cvarIfRejected)} · liq horizon {c.counterfactual.liquidityHorizonIfRejected.toFixed(1)}d · forced-sale risk{' '}
                <span className={c.counterfactual.forcedSaleRisk === 'HIGH' ? 'text-[#EF4444]' : c.counterfactual.forcedSaleRisk === 'MEDIUM' ? 'text-[#f5c069]' : 'text-zinc-400'}>
                  {c.counterfactual.forcedSaleRisk}
                </span>
              </div>
              <div className="mt-1">{c.counterfactual.note}</div>
            </div>
            <div className="mt-2.5 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-[#1F1F23] bg-transparent px-2.5 text-[11px] text-[#10B981] hover:border-[#1f3a2a] hover:bg-[#0d1512] hover:text-[#10B981]"
                disabled={busy}
                onClick={() => onDecide(c.id, 'APPROVED')}
              >
                <BadgeCheck size={12} strokeWidth={1.5} /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-[#1F1F23] bg-transparent px-2.5 text-[11px] text-[#EF4444] hover:border-[#3a1f1f] hover:bg-[#150f10] hover:text-[#EF4444]"
                disabled={busy}
                onClick={() => onDecide(c.id, 'REJECTED')}
              >
                <Ban size={12} strokeWidth={1.5} /> Reject
              </Button>
            </div>
          </div>
        ))}
        {recent.map((c) => (
          <div key={c.id} className="flex items-center justify-between border border-[#161619] px-2.5 py-1.5 text-[11px]">
            <span className="num text-zinc-500">
              {c.id} · {c.trade.direction === -1 ? 'SELL' : 'BUY'} {c.trade.bucket} {cr(c.trade.value)}
            </span>
            <span className={`num ${c.status === 'APPROVED' ? 'text-[#10B981]' : c.status === 'REJECTED' ? 'text-[#EF4444]' : 'text-zinc-500'}`}>
              {c.status} · {c.decidedBy}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConstitutionPanel({ checks }: { checks: Check[] }) {
  return (
    <div>
      <SectionLabel right={checks.length ? `${checks.filter((c) => !c.passed).length} fired` : '—'}>Constitution A1–A9</SectionLabel>
      <div className="max-h-72 overflow-y-auto pr-1 scrollbar-terminal">
        {checks.length === 0 ? (
          <EmptyState icon={<Scale size={14} strokeWidth={1.5} />} text={<span>No evaluation yet — start a replay or run a live rebalance. The constitution evaluates every proposal before anything moves.</span>} />
        ) : (
          checks.map((c) => (
            <div key={c.article} className="flex items-start gap-2 border-b border-[#161619] py-1.5 last:border-0">
              <span className={`num w-6 shrink-0 text-[11px] ${c.passed ? 'text-zinc-500' : 'text-[#f5c069]'}`}>{c.article}</span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12px] leading-4 ${c.passed ? 'text-zinc-300' : 'text-zinc-100'}`}>{c.title}</span>
                <span className="num block text-[11px] leading-4 text-zinc-500">{c.detail}</span>
              </span>
              <span className={`num shrink-0 text-[10px] ${c.passed ? 'text-zinc-600' : 'text-[#f5c069]'}`}>{c.passed ? 'PASS' : 'FIRED'}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 border border-dashed border-[#1F1F23] px-3 py-3 text-[11px] leading-relaxed text-zinc-500">
      <span className="mt-px shrink-0 text-zinc-600">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

/** The autonomy dial: FULL → SUPERVISED → CONSERVATIVE. One-way ratchet
 *  in CRISIS (blocked moves recorded). This is a REAL control, not a prop. */
function AutonomyDial({
  level,
  regime,
  ratchetArmed,
  onSet,
  disabled,
}: {
  level: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE';
  regime: string;
  ratchetArmed?: boolean;
  onSet: (l: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE') => void;
  disabled?: boolean;
}) {
  const LEVELS: { id: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE'; label: string; hint: string }[] = [
    { id: 'FULL', label: 'FULL', hint: 'Agent acts alone within A1–A9' },
    { id: 'SUPERVISED', label: 'SUP', hint: 'Trades > 1% NAV or any CRISIS trade need consent' },
    { id: 'CONSERVATIVE', label: 'CONS', hint: 'Every trade needs a consent card' },
  ];
  const idx = LEVELS.findIndex((l) => l.id === level);
  return (
    <div>
      <SectionLabel
        right={
          ratchetArmed ? (
            <span className="flex items-center gap-1 text-[#f5c069]" title="One-way ratchet armed (CRISis): the dial may only move toward more scrutiny until the crisis passes">
              <Gauge size={10} strokeWidth={1.5} /> ratchet armed
            </span>
          ) : (
            <span>{regime}</span>
          )
        }
      >
        Autonomy dial · A8
      </SectionLabel>
      <div className="flex border border-[#26262b]" role="radiogroup" aria-label="autonomy level">
        {LEVELS.map((l, i) => {
          const active = i === idx;
          const locked = disabled || (ratchetArmed === true && i < idx);
          return (
            <button
              key={l.id}
              role="radio"
              aria-checked={active}
              title={locked && ratchetArmed ? 'ratchet: only more scrutiny allowed in CRISIS' : l.hint}
              disabled={disabled}
              onClick={() => onSet(l.id)}
              className={`num flex-1 px-2 py-1.5 text-[10px] tracking-wide transition-colors duration-150 ${
                active
                  ? 'bg-[#1c1710] text-[#f5c069]'
                  : locked
                    ? 'cursor-not-allowed text-zinc-700'
                    : 'text-zinc-400 hover:bg-[#131317] hover:text-zinc-200'
              } ${i > 0 ? 'border-l border-[#26262b]' : ''}`}
            >
              {locked ? '· ' : ''}
              {l.label}
            </button>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] leading-3 text-zinc-600">
        {idx === 0 ? 'FULL: acts alone within the constitution; consent cards only from the Critic.' : idx === 1 ? 'SUPERVISED: oversized or crisis trades pause for a human.' : 'CONSERVATIVE: every trade pauses for a human.'}
      </div>
    </div>
  );
}

function RadarRow({ e, link, onSelect }: { e: RadarEvent; link?: string; onSelect?: (e: RadarEvent) => void }) {
  const isAi = e.provider === 'gemini' || e.provider === 'llm';
  const tick = e.severity >= 4 ? 'border-l-[#EF4444]' : e.severity === 3 ? 'border-l-[#F5A623]' : 'border-l-transparent';
  return (
    <div
      className={`border-b border-l-2 border-[#161619] py-2 pl-2.5 last:border-0 transition-colors duration-150 hover:bg-[#131317] ${tick} ${onSelect ? 'cursor-pointer' : ''}`}
      onClick={() => onSelect?.(e)}
      onKeyDown={(ev) => {
        if (onSelect && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          onSelect(e);
        }
      }}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `radar event detail: ${e.headline}` : undefined}
    >
      <div className="flex items-start gap-2">
        <SeverityChip sev={e.severity} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] leading-4 text-zinc-200" title={e.headline}>
            {e.headline}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
            <span className="num">{e.event}</span>
            {e.buckets.length > 0 ? <span className="num">{e.buckets.join(' · ')}</span> : null}
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
                onClick={(ev) => ev.stopPropagation()}
              >
                <Link2 size={10} strokeWidth={1.5} /> {e.source}
              </a>
            ) : (
              <span>{e.source}</span>
            )}
            <span className={`num ${isAi ? 'text-[#f5c069]' : 'text-zinc-600'}`}>{isAi ? 'GEMINI' : 'DICT'}</span>
            {e.applied ? <span className="text-[#10B981]">tightened ✓</span> : <span className="text-zinc-600">inert</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function RadarFeed({ events, links }: { events: RadarEvent[]; links?: Record<string, string> }) {
  const [sel, setSel] = useState<RadarEvent | null>(null);
  return (
    <div>
      <SectionLabel right={`${events.length} events`}>Event radar · A7 tighten-only</SectionLabel>
      <div className="max-h-96 overflow-y-auto pr-1 scrollbar-terminal">
        {events.length === 0 ? (
          <EmptyState
            icon={<Radio size={14} strokeWidth={1.5} />}
            text={<span>No radar events yet — the news poll fires every 15 minutes (zero-key: Google News RSS + GDELT). Every applied event can only tighten.</span>}
          />
        ) : (
          events
            .slice()
            .reverse()
            .map((e, i) => <RadarRow key={`${e.day}-${e.event}-${i}`} e={e} link={links?.[e.headline]} onSelect={setSel} />)
        )}
      </div>
      {sel ? <RadarDetailSheet e={sel} link={links?.[sel.headline]} onClose={() => setSel(null)} /> : null}
    </div>
  );
}

function RecorderStrip({ entries, headHash, chainValid, onExpand }: { entries: number; headHash: string; chainValid: boolean; onExpand?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border border-[#1F1F23] bg-[#101013] px-3 py-2 text-[11px] text-zinc-500">
      <span className="flex items-center gap-1.5">
        <FileClock size={12} strokeWidth={1.5} className="text-zinc-600" />
        <span className="section-label">Flight recorder</span>
      </span>
      <span className="num text-zinc-300">{entries} entries</span>
      <span className="num text-zinc-500">head {headHash ? headHash.slice(0, 16) + '…' : '—'}</span>
      <span className={`num flex items-center gap-1 ${chainValid ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
        <Shield size={10} strokeWidth={1.5} /> {chainValid ? 'chain verified' : 'CHAIN INVALID'}
      </span>
      {onExpand ? (
        <button
          onClick={onExpand}
          className="num ml-auto flex items-center gap-1 border border-[#26262b] px-1.5 py-px text-[10px] text-zinc-300 transition-colors duration-150 hover:bg-[#1c1710] hover:text-[#f5c069]"
          title="Browse the hash-chained evidence, day by day"
        >
          <ChevronRight size={10} strokeWidth={1.5} /> audit
        </button>
      ) : (
        <span className="text-zinc-600">SHA-256 prev→entry · append-only JSONL · survives restarts</span>
      )}
    </div>
  );
}

interface RecorderEntryView {
  seq: number;
  day: number;
  kind: string;
  payload: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

const KIND_TONE: Record<string, string> = {
  MARGIN_CALL: 'text-[#EF4444]',
  FORCED_SALE: 'text-[#EF4444]',
  MARGIN_RELEASE: 'text-[#10B981]',
  REJECTED_BY_A7: 'text-[#f5c069]',
  RADAR: 'text-[#f5c069]',
  REGIME: 'text-[#f5c069]',
  AI_ADVISOR: 'text-[#f5c069]',
  AI_CRITIC: 'text-[#f5c069]',
  EXECUTION: 'text-zinc-100',
  APPROVAL_REQUEST: 'text-[#f5a623]',
  APPROVAL_DECISION: 'text-[#f5a623]',
  APPROVAL_TIMEOUT: 'text-zinc-400',
  AUTONOMY: 'text-[#f5a623]',
  RATCHET_BLOCK: 'text-[#f5c069]',
};

function kindTone(kind: string): string {
  return KIND_TONE[kind] ?? 'text-zinc-400';
}

/** Compact one-line payload digest for the audit list. */
function entryDigest(e: RecorderEntryView): string {
  const p = e.payload;
  switch (e.kind) {
    case 'OBSERVATION':
      return `NAV ${String(p.nav_str ?? '')} · regime ${String(p.regime ?? '')} · residual ${String(p.ledger_residual ?? '')}`;
    case 'RADAR':
      return `sev ${String(p.severity ?? '?')} ${String(p.event ?? '')} → ${p.applied ? 'tighten' : 'inert'}`;
    case 'REJECTED_BY_A7':
      return `model tried to loosen — rejected · ${String(p.reason ?? '')}`;
    case 'MARGIN_CALL':
      return `${String(p.channel ?? '')} call ₹${String(p.call_cr ?? '?')} Cr · forced ₹${String(p.forced_sale_cr ?? '0')} Cr`;
    case 'MARGIN_RELEASE':
      return `${String(p.channel ?? '')} released ₹${String(p.released_cr ?? '?')} Cr`;
    case 'EXECUTION':
      return `${p.dir === 1 ? 'BUY' : 'SELL'} ${String(p.bucket ?? '')} ₹${String(p.value_cr ?? '?')} Cr @ ${(Number(p.participation ?? 0) * 100).toFixed(1)}% ADV${p.origin ? ` · ${String(p.origin)}` : ''}`;
    case 'PROPOSAL':
      return `${String(p.status ?? '')} · ${Array.isArray(p.intents) ? p.intents.length : 0} intents · CVaR ${String(p.cvar ?? '')}`;
    case 'CONSTITUTION':
      return `${Array.isArray(p.checks) ? p.checks.filter((c: { pass?: boolean }) => !c.pass).length : 0} of ${Array.isArray(p.checks) ? p.checks.length : 0} articles fired`;
    case 'APPROVAL_REQUEST':
      return `${String(p.id ?? '')} · ${String(p.bucket ?? '')} ₹${String(p.value_cr ?? '?')} Cr · deadline d+${String(p.deadline_day ?? '?')}`;
    case 'APPROVAL_DECISION':
      return `${String(p.id ?? '')} ${String(p.decision ?? '')} by ${String(p.by ?? '')}`;
    case 'APPROVAL_TIMEOUT':
      return `${String(p.id ?? '')} timed out — trade not executed`;
    case 'FORCED_SALE':
      return `${String(p.bucket ?? '')} ₹${String(p.value_cr ?? '?')} Cr @ ${(Number(p.participation ?? 0) * 100).toFixed(1)}% ADV · ${String(p.reason ?? '')}`;
    case 'REGIME':
      return `${String(p.from ?? '')} → ${String(p.to ?? '')} · ${String(p.why ?? '')}`;
    case 'AI_ADVISOR':
      return `${String(p.status ?? '')} · ${String(p.bucket ?? '')} ${String(p.action ?? '')} · ${String(p.clip_reason ?? p.reason ?? '')}`;
    case 'AI_CRITIC':
      return `${String(p.verdict ?? p.status ?? '')} · worst ${String(p.worst_bucket ?? '—')}${p.ignored_risk ? ` · ${String(p.ignored_risk).slice(0, 60)}` : ''}`;
    case 'AI_ADVISOR_REJECTED':
      return String(p.reason ?? 'rejected by schema');
    case 'REDEMPTION':
      return `₹${String(p.amount_cr ?? '?')} Cr asked · paid ₹${String(p.paid_cr ?? '?')} Cr · forced ₹${String(p.forced_sale_cr ?? '0')} Cr`;
    case 'OPTIMIZER':
      return `λ ${String(p.lambda ?? '')} · CVaR ${String(p.cvar ?? '')} vs ${String(p.limit ?? '')} · gross cap ${String(p.gross_cap ?? '')}`;
    case 'SESSION_START':
    case 'SESSION_END':
    case 'SESSION_RESUME':
      return `mode ${String(p.mode ?? 'live')} · NAV ${String(p.nav_day0 ?? p.nav_end_cr ?? '')} Cr`;
    case 'AUTONOMY':
      return `${String(p.from ?? '')} → ${String(p.to ?? '')} by ${String(p.by ?? 'human')}`;
    case 'RATCHET_BLOCK':
      return `attempted ${String(p.attempted ?? '')} · blocked (CRISIS ratchet)`;
    default:
      return JSON.stringify(p).slice(0, 90);
  }
}

/** The audit surface: browse hash-chained entries day by day, payload on tap. */
function RecorderBrowser({
  endpoint,
  day,
  onClose,
}: {
  endpoint: string;
  day: number;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<RecorderEntryView[] | null>(null);
  const [meta, setMeta] = useState<{ chainValid: boolean; headHash: string; total: number } | null>(null);
  const [from, setFrom] = useState(Math.max(0, day - 3));
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // day-window query with cancellation (state lands only if the window is current)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sep = endpoint.includes('?') ? '&' : '?';
        const d = await api<{ entries: RecorderEntryView[]; chainValid: boolean; headHash: string; total: number }>(
          `${endpoint}${sep}from=${from}&to=${from + 2}&limit=300`
        );
        if (cancelled) return;
        setEntries(d.entries);
        setMeta({ chainValid: d.chainValid, headHash: d.headHash, total: d.total });
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'recorder query failed');
        setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, from]);

  return (
    <div className="border border-[#1F1F23] bg-[#101013]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#1F1F23] px-3 py-2">
        <span className="section-label flex items-center gap-1.5">
          <FileClock size={12} strokeWidth={1.5} className="text-zinc-600" /> Flight recorder — evidence
        </span>
        {meta ? (
          <>
            <span className="num text-[10px] text-zinc-300">{meta.total} total</span>
            <span className={`num text-[10px] ${meta.chainValid ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>{meta.chainValid ? 'chain verified' : 'CHAIN INVALID'}</span>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="num border border-[#26262b] px-1.5 py-px text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200 disabled:opacity-40"
            disabled={from === 0}
            onClick={() => setFrom(Math.max(0, from - 3))}
            title="Previous 3 days"
          >
            ← d{Math.max(0, from - 3)}
          </button>
          <span className="num border border-[#26262b] bg-[#1c1710] px-1.5 py-px text-[10px] text-[#f5c069]">days {from}–{from + 2}</span>
          <button
            className="num border border-[#26262b] px-1.5 py-px text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
            onClick={() => setFrom(from + 3)}
            title="Next 3 days"
          >
            d{from + 3} →
          </button>
          <button
            className="num ml-1 border border-[#26262b] px-1.5 py-px text-[10px] text-zinc-500 transition-colors duration-150 hover:text-zinc-200"
            onClick={onClose}
            title="Collapse the audit browser"
          >
            close
          </button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto scrollbar-terminal">
        {err ? (
          <div className="px-3 py-3 text-[11px] text-[#EF4444]">{err}</div>
        ) : entries === null ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" style={{ animationDuration: '1.2s' }} /> reading the chain…
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<FileClock size={14} strokeWidth={1.5} />}
            text={<span>No entries in days {from}–{from + 2}. Move the day window or start a run — every observation, proposal, approval and execution lands here with its hash.</span>}
          />
        ) : (
          entries.map((e) => (
            <div key={e.seq} className="border-b border-[#161619] last:border-0">
              <button
                className="flex w-full items-baseline gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-[#131317]"
                onClick={() => setOpenSeq(openSeq === e.seq ? null : e.seq)}
                title={openSeq === e.seq ? 'Collapse payload' : 'Inspect the canonical payload'}
              >
                <span className="num w-9 shrink-0 text-[10px] text-zinc-600">#{e.seq}</span>
                <span className="num w-7 shrink-0 text-[10px] text-zinc-500">d{e.day}</span>
                <span className={`num w-36 shrink-0 truncate text-[10px] ${kindTone(e.kind)}`}>{e.kind}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">{entryDigest(e)}</span>
                <span className="num hidden shrink-0 text-[9px] text-zinc-700 sm:inline">{e.entryHash.slice(0, 8)}</span>
              </button>
              {openSeq === e.seq ? (
                <pre className="max-h-44 overflow-auto border-t border-[#161619] bg-[#0C0C0E] px-3 py-2 font-mono text-[10px] leading-4 text-zinc-400 scrollbar-terminal">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="border-t border-[#1F1F23] px-3 py-1.5 text-[10px] text-zinc-600">
        Append-only JSONL · SHA-256 over canonical payloads · prev→entry chaining · the DB is state, this is proof.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- replay lab

function ReplayLab({
  state,
  playing,
  setPlaying,
  onStart,
  onStep,
  speed,
  setSpeed,
  onDecide,
  deciding,
  onPostMortem,
  onSetAutonomy,
  ratchetArmed,
  markers,
}: {
  state: ReplayState | null;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  onStart: (id: string) => void;
  onStep: (n: number) => void;
  speed: number;
  setSpeed: (v: number) => void;
  onDecide: (id: string, d: 'APPROVED' | 'REJECTED') => void;
  deciding: boolean;
  onPostMortem: () => void;
  onSetAutonomy: (l: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE') => void;
  ratchetArmed: boolean;
  markers: Marker[];
}) {
  const [pmOpen, setPmOpen] = useState(false);
  const [pmDismissed, setPmDismissed] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const g = state?.bots['governed'];
  const n = state?.bots['naive'];
  const postMortem = state?.postMortem;
  // auto-open on completion; a manual close (esc) dismisses until re-opened
  const showPm = Boolean(postMortem) && !pmDismissed && (pmOpen || state?.complete);

  if (!state || !state.active) {
    return (
      <div className="grid gap-3 lg:grid-cols-[240px_1fr_340px]">
        <ScenarioRail selected={null} onSelect={onStart} />
        <div className="flex min-h-[420px] items-center justify-center border border-dashed border-[#1F1F23]">
          <div className="max-w-md px-6 text-center">
            <FlaskConical size={20} strokeWidth={1.5} className="mx-auto mb-3 text-zinc-600" />
            <div className="text-[15px] text-zinc-200">Pick a crisis. Press 1, 2 or 3.</div>
            <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">
              Each script replays a real Indian market crisis twice on the same world (seed 42): a
              naive vol-target rebalancer versus the KAVACH-governed agent. Same prices, same noise,
              same margins — only the constitution differs. Every decision lands in the hash-chained
              flight recorder.
            </p>
          </div>
        </div>
        <div className="space-y-3">
          <RadarFeed events={[]} />
          <ApprovalsInbox cards={[]} onDecide={() => {}} />
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[240px_1fr_340px]">
      {/* left rail */}
      <div className="space-y-3">
        <ScenarioRail selected={state.scenario.id} onSelect={onStart} />
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={`d${state.day}/${state.scenario.days}`}>Transport</SectionLabel>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-8 w-8 border border-[#26262b] bg-[#131317] p-0 text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={() => setPlaying(!playing)}
              disabled={state.complete}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playing ? <Pause size={14} strokeWidth={1.5} /> : <Play size={14} strokeWidth={1.5} />}
            </Button>
            <Button
              size="sm"
              className="h-8 w-8 border border-[#26262b] bg-[#131317] p-0 text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={() => onStep(1)}
              disabled={state.complete}
              title="Step one day (→)"
            >
              <StepForward size={14} strokeWidth={1.5} />
            </Button>
            <Button
              size="sm"
              className="h-8 w-8 border border-[#26262b] bg-[#131317] p-0 text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={() => onStep(999)}
              disabled={state.complete}
              title="Run to the end"
            >
              <ChevronRight size={14} strokeWidth={1.5} />
            </Button>
            <div className="ml-1 flex items-center border border-[#26262b]">
              {[1, 2, 4, 8].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`num px-1.5 py-1 text-[10px] transition-colors duration-150 ${speed === s ? 'bg-[#1c1710] text-[#f5c069]' : 'text-zinc-500 hover:text-zinc-300'}`}
                  title={`${s} day${s > 1 ? 's' : ''} per second`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <div className="num mt-2 flex items-center justify-between text-[11px] text-zinc-500">
            <span>seed {state.seed} · {state.mode === 'both' ? 'A/B both' : state.mode}</span>
            <span>{state.complete ? 'COMPLETE' : playing ? `running ${speed}×` : 'paused'}</span>
          </div>
        </div>
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <AutonomyDial
            level={state.autonomy}
            regime={state.bots['governed']?.regime ?? 'CALM'}
            ratchetArmed={ratchetArmed}
            onSet={onSetAutonomy}
            disabled={!state.bots['governed']}
          />
        </div>
        {g ? (
          <div className="border border-[#1F1F23] bg-[#101013] p-3">
            <SectionLabel>Governor</SectionLabel>
            <dl className="space-y-1.5 text-[12px]">
              <StatRow label="NAV" value={fmt_inr(g.nav)} tone="text-zinc-100" />
              <StatRow label="Drawdown" value={pct(g.drawdown, 1)} tone={g.drawdown < -0.05 ? 'text-[#EF4444]' : 'text-zinc-300'} />
              <StatRow label="1d CVaR" value={`${pct(g.cvar95)} / ${pct(g.cvarLimit)}`} tone={g.cvar95 > g.cvarLimit ? 'text-[#f5c069]' : 'text-zinc-300'} />
              <StatRow label="Liq horizon" value={`${g.liquidityDays.toFixed(1)} days`} tone="text-zinc-300" />
              <StatRow label="Vol (ann.)" value={pct(g.ewmaPortfolioVolAnn, 1)} tone="text-zinc-300" />
              <StatRow label="Impact paid" value={cr(g.impactPaid)} tone="text-zinc-300" />
              <StatRow label="Peak ADV use" value={pct(g.maxParticipation, 1)} tone={g.maxParticipation > 0.101 ? 'text-[#f5c069]' : 'text-[#10B981]'} />
              <StatRow label="Forced legs" value={`${g.forcedSaleEvents}`} tone={g.forcedSaleEvents ? 'text-[#EF4444]' : 'text-[#10B981]'} />
              <StatRow label="Missed redemptions" value={`${g.redemptionsMissed}`} tone={g.redemptionsMissed ? 'text-[#EF4444]' : 'text-[#10B981]'} />
            </dl>
          </div>
        ) : null}
        {g ? (
          <div className="border border-[#1F1F23] bg-[#101013] p-3">
            <SectionLabel right="replay caps">Risk budget</SectionLabel>
            <ReplayRiskStrip g={g} />
          </div>
        ) : null}
        {state.headline ? (
          <div className="border border-[#1F1F23] bg-[#101013] p-3">
            <SectionLabel>Scripted headline · d{state.headline.day}</SectionLabel>
            <p className="text-[12px] leading-relaxed text-zinc-300">{state.headline.text}</p>
          </div>
        ) : null}
      </div>

      {/* main column */}
      <div className="space-y-3">
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <div className="flex items-baseline justify-between pb-2">
            <span className="section-label">A/B · NAV — same world, seed {state.seed}</span>
            <span className="flex items-center gap-3 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><span className="inline-block h-px w-4 border-t border-dashed border-[#EF4444]" /> NaiveBot</span>
              <span className="flex items-center gap-1"><span className="inline-block h-px w-4 border-t border-solid border-zinc-100" /> KAVACH</span>
              <span className="flex items-center gap-1"><CircleDot size={8} className="text-[#F5A623]" /> radar</span>
              <span className="flex items-center gap-1"><CircleDot size={8} className="text-[#EF4444]" /> margin</span>
            </span>
          </div>
          <ABNavChart naive={n} governed={g} markers={markers} />
          <div className="mt-1 hairline-t pt-1">
            <span className="section-label">Drawdown — KAVACH</span>
            <DrawdownStrip series={g?.navSeries ?? []} />
          </div>
          {state.abHeadline ? (
            <div className="mt-1 hairline-t pt-2 text-[12px] leading-relaxed text-zinc-300">{state.abHeadline}</div>
          ) : null}
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={g ? `${(g.gross / CR).toFixed(0)} Cr gross · MTF ${cr(g.borrowings)}` : ''}>Book — KAVACH agent</SectionLabel>
          {g ? (
            <BookTable values={g.values} prices={g.prices} rets={Object.fromEntries(g.bucketStats.map((s) => [s.bucket, s.ret1d]))} />
          ) : (
            <div className="flex items-start gap-2 border border-dashed border-[#1F1F23] px-3 py-3 text-[11px] leading-relaxed text-zinc-500">
              <span className="mt-px shrink-0 text-zinc-600">
                <Landmark size={14} strokeWidth={1.5} />
              </span>
              <span>
                No replay running. Pick a crisis on the left rail — or press{' '}
                <kbd className="kbd">1</kbd> <kbd className="kbd">2</kbd> <kbd className="kbd">3</kbd> for Taper Tantrum / IL&amp;FS /
                COVID, and <kbd className="kbd">space</kbd> to autoplay. The naive bot and the governed bot will run side by side
                from the same seed; everything either one does lands in a hash-chained flight recorder.
              </span>
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {n ? (
            <div className="border border-[#1F1F23] bg-[#101013] p-3">
              <SectionLabel right={state.naivePnlStr ?? ''}>NaiveBot — the villain</SectionLabel>
              <dl className="space-y-1 text-[12px]">
                <StatRow label="NAV" value={fmt_inr(n.nav)} tone="text-zinc-200" />
                <StatRow label="Cascade days" value={`${n.cascadeDays}`} tone={n.cascadeDays ? 'text-[#EF4444]' : 'text-zinc-400'} />
                <StatRow label="Peak ADV use" value={pct(n.maxParticipation, 0)} tone={n.maxParticipation > 0.11 ? 'text-[#EF4444]' : 'text-zinc-400'} />
                <StatRow label="Impact paid" value={cr(n.impactPaid)} tone="text-zinc-400" />
                <StatRow label="Margin calls" value={cr(n.marginCumulative)} tone="text-zinc-400" />
              </dl>
            </div>
          ) : null}
          <div className="border border-[#1F1F23] bg-[#101013] p-3">
            <SectionLabel>Recorder proof</SectionLabel>
            <RecorderStrip
              entries={state.recorderSize.governed}
              headHash={state.recorderHead.governed}
              chainValid={true}
              onExpand={() => setAuditOpen((v) => !v)}
            />
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <a
                href="/api/kavach/replay/export?kind=equity"
                download
                className="num flex h-7 items-center justify-start gap-1.5 border border-[#26262b] bg-[#131317] px-2.5 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
                title="A/B equity curves as CSV — both bots, day by day, from the live controller state"
              >
                <Download size={11} strokeWidth={1.5} /> equity .csv
              </a>
              <a
                href="/api/kavach/replay/export?kind=recorder&bot=governed"
                download
                className="num flex h-7 items-center justify-start gap-1.5 border border-[#26262b] bg-[#131317] px-2.5 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
                title="The governed bot's hash-chained evidence — JSONL, hashes intact"
              >
                <Download size={11} strokeWidth={1.5} /> recorder .jsonl
              </a>
            </div>
            {auditOpen ? (
              <div className="mt-2">
                <RecorderBrowser endpoint="/api/kavach/flightrecorder?bot=governed" day={state.day} onClose={() => setAuditOpen(false)} />
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
                disabled={!state.complete || !!postMortem}
                onClick={() => {
                  onPostMortem();
                  setPmOpen(true);
                  setPmDismissed(false);
                }}
              >
                <ScrollText size={12} strokeWidth={1.5} /> {postMortem ? 'Post-mortem ready' : 'Generate post-mortem'}
              </Button>
              {postMortem ? (
                <span className="num text-[10px] text-zinc-500">
                  {postMortem.provider === 'gemini' ? 'GEMINI' : 'TEMPLATE'} · {postMortem.latencyMs}ms
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* right rail */}
      <div className="space-y-3">
        <RadarFeed events={g?.radarFeed ?? []} />
        <ApprovalsInbox cards={g?.approvals ?? []} onDecide={onDecide} busy={deciding} />
        <ConstitutionPanel checks={g?.constitution ?? []} />
      </div>

      {showPm && postMortem ? (
        <PostMortemSheet markdown={postMortem.markdown} onClose={() => setPmDismissed(true)} title={`Post-mortem — ${state.scenario.title}`} />
      ) : null}
    </div>
  );
}

function ScenarioRail({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-1.5">
      <SectionLabel>Scenario scripts</SectionLabel>
      {SCENARIOS.map((s, i) => {
        const active = selected === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group w-full border p-2.5 text-left transition-colors duration-150 ${
              active
                ? 'edge-active border-[#3a2d14] bg-[#1c1710]'
                : 'border-[#1F1F23] bg-[#101013] hover:border-[#2a2a30]'
            }`}
            title={`Press ${s.key} — ${s.title}`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-[13px] ${active ? 'text-[#f5c069]' : 'text-zinc-200'}`}>{s.title}</span>
              <kbd className="num border border-[#26262b] px-1 text-[10px] text-zinc-500">{s.key}</kbd>
            </div>
            <div className="num mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
              <span>{s.tag}</span>
              <span>· {s.days}d</span>
            </div>
            <p className={`mt-1 text-[11px] leading-4 ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>{s.story}</p>
          </button>
        );
      })}
    </div>
  );
}

function StatRow({ label, value, tone, flash }: { label: string; value: string; tone?: string; flash?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className={`num text-[12px] ${flash ? 'flash-num ' : ''}${tone ?? 'text-zinc-300'}`}>{value}</dd>
    </div>
  );
}

/** True for ~650 ms after `value` changes — a quiet amber pulse on moving numbers.
 *  State changes happen inside timeout callbacks (never synchronously in the effect body). */
function useFlash(value: number): boolean {
  const [flashUntil, setFlashUntil] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const t = setTimeout(() => setFlashUntil(Date.now() + 650), 0);
    return () => clearTimeout(t);
  }, [value]);
  useEffect(() => {
    if (flashUntil > Date.now()) {
      const t = setTimeout(() => setFlashUntil(0), 700);
      return () => clearTimeout(t);
    }
  }, [flashUntil]);
  return Date.now() < flashUntil;
}

function PostMortemSheet({ markdown, onClose, title }: { markdown: string; onClose: () => void; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[#1F1F23] bg-[#0D0D10] shadow-[0_-8px_24px_rgba(0,0,0,0.5)]">
      <div className="mx-auto max-w-6xl px-4 py-3">
        <div className="flex items-center justify-between pb-2">
          <span className="section-label">{title}</span>
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200"
              onClick={() => downloadText('kavach-replay-postmortem.md', markdown, 'text/markdown;charset=utf-8')}
              title="Download the post-mortem as markdown"
            >
              <Download size={12} strokeWidth={1.5} /> .md
            </Button>
            <Button size="sm" className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200" onClick={onClose}>
              close (esc)
            </Button>
          </span>
        </div>
        <div ref={ref} className="max-h-80 overflow-y-auto pr-2 scrollbar-terminal">
          <MarkdownLite text={markdown} />
        </div>
      </div>
    </div>
  );
}

/** Minimal markdown renderer (headings, bold, lists, links) — no AI slop, just text. */
function MarkdownLite({ text }: { text: string }) {
  const blocks = text.split('\n');
  return (
    <div className="space-y-1.5 text-[12px] leading-relaxed text-zinc-300">
      {blocks.map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <div key={i} className="section-label pt-2">
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith('### ')) {
          return (
            <div key={i} className="pt-1 text-[13px] text-zinc-100">
              {line.slice(4)}
            </div>
          );
        }
        if (line.startsWith('**') && line.endsWith('**')) {
          return (
            <div key={i} className="text-[12px] text-zinc-100">
              {line.slice(2, -2)}
            </div>
          );
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
              <span>{renderInline(line.slice(2))}</span>
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        return <div key={i}>{renderInline(line)}</div>;
      })}
    </div>
  );
}

function renderInline(s: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    if (m[1]) parts.push(<strong key={k++} className="text-zinc-100">{m[1]}</strong>);
    else if (m[2] && m[3])
      parts.push(
        <a key={k++} href={m[3]} target="_blank" rel="noopener noreferrer" className="text-[#f5c069] underline decoration-dotted underline-offset-2">
          {m[2]}
        </a>
      );
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// ---------------------------------------------------------------- live paper

function LivePaper({
  state,
  busy,
  onPoll,
  onRebalance,
  onDecide,
  onPostMortem,
  onReset,
  onSetAutonomy,
  onStress,
  ratchetArmed,
  sessionKey,
}: {
  state: LiveState | null;
  busy: string | null;
  onPoll: () => void;
  onRebalance: () => void;
  onDecide: (id: string, d: 'APPROVED' | 'REJECTED') => void;
  onPostMortem: () => void;
  onReset: () => void;
  onSetAutonomy: (l: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE') => void;
  onStress: () => void;
  ratchetArmed: boolean;
  sessionKey: number;
}) {
  const [pm, setPm] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const navFlash = useFlash(state ? state.nav : 0);
  if (!state) {
    return (
      <div className="grid gap-3 lg:grid-cols-[240px_1fr_340px]">
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row h-[92px] border border-[#1F1F23]" aria-hidden />
          ))}
        </div>
        <div className="space-y-3">
          <div className="skeleton-row h-[320px] border border-[#1F1F23]" aria-hidden />
          <div className="skeleton-row h-[220px] border border-[#1F1F23]" aria-hidden />
        </div>
        <div className="space-y-3">
          <div className="skeleton-row h-[180px] border border-[#1F1F23]" aria-hidden />
          <div className="skeleton-row h-[140px] border border-[#1F1F23]" aria-hidden />
        </div>
        <span className="sr-only">Opening the live paper book…</span>
      </div>
    );
  }
  const navRet = state.nav / state.navStart - 1;
  const aiAdvisor = state.ai.advisor;
  const aiCritic = state.ai.critic;
  const links: Record<string, string> = {};
  for (const l of state.radarLog) if (l.reading.sourceUrl) links[l.headline] = l.reading.sourceUrl;

  return (
    <div className="grid gap-3 lg:grid-cols-[240px_1fr_340px]">
      {/* left rail */}
      <div className="space-y-3">
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={state.market.istTime + ' IST'}>Market</SectionLabel>
          <div className={`flex items-center gap-2 text-[13px] ${state.market.open ? 'text-[#10B981]' : 'text-zinc-400'}`}>
            {state.market.open ? <ActivitySquare size={14} strokeWidth={1.5} /> : <Clock size={14} strokeWidth={1.5} />}
            {state.market.open ? 'NSE OPEN' : 'MARKET CLOSED'}
          </div>
          <p className="mt-1 text-[11px] leading-4 text-zinc-500">
            {state.market.open ? state.market.reason : `${state.market.reason} — prices as of last close; no rebalance fires outside 09:15–15:30 IST.`}
          </p>
          {!state.market.open ? (
            <div className="num mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400" title="Next NSE session (approximate — exchange holidays are not modeled client-side)">
              <ArrowRight size={10} strokeWidth={1.5} className="text-zinc-600" />
              opens {nextOpenLabel(state.market.istDate, state.market.istTime)}
            </div>
          ) : null}
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={state.providers.price.state === 'stale' ? 'stale' : state.real ? 'live' : '…'}>Real marks</SectionLabel>
          {state.real ? (
            <dl className="space-y-1.5 text-[12px]">
              <StatRow label="NIFTY 50" value={state.real.eq.toLocaleString('en-IN', { maximumFractionDigits: 1 })} tone="text-zinc-100" />
              <StatRow label="USD/INR" value={state.real.usdinr.toFixed(3)} tone="text-zinc-300" />
              <StatRow label="Gold ₹/10g eq." value={Math.round(state.real.goldInr / 31.1035 * 10).toLocaleString('en-IN')} tone="text-zinc-300" />
            </dl>
          ) : (
            <p className="text-[11px] text-zinc-500">First price poll pending… (Yahoo Finance chart endpoint, 10-minute cache, last-known-good fallback.)</p>
          )}
          <div className="num mt-2 text-[10px] text-zinc-600">
            {state.providers.price.state === 'stale' ? 'yahoo unreachable — serving last known good' : state.real ? `as of ${hhmmss(Date.parse(state.real.asOf))}` : 'never fetched'}
          </div>
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={`d${state.day}`}>Live book</SectionLabel>
          <dl className="space-y-1.5 text-[12px]">
            <StatRow label="NAV" value={fmt_inr(state.nav)} tone="text-zinc-100" flash={navFlash} />
            <StatRow label="Since start" value={`${sign(navRet * 100)}%`} tone={tone(navRet)} flash={navFlash} />
            <StatRow label="Gross" value={cr(state.book.gross)} tone="text-zinc-300" />
            <StatRow label="MTF borrowings" value={cr(state.book.borrowings)} tone="text-zinc-300" />
            <StatRow label="Margin (cum.)" value={cr(state.book.marginCumulative)} tone="text-zinc-300" />
            <StatRow label="1d CVaR" value={`${pct(state.risk.cvar95)} / ${pct(state.risk.cvarLimit)}`} tone={state.risk.cvar95 > state.risk.cvarLimit ? 'text-[#f5c069]' : 'text-zinc-300'} />
            <StatRow label="Liq horizon" value={`${state.risk.liquidityDays.toFixed(1)} d`} tone="text-zinc-300" />
            <StatRow label="Peak ADV use" value={pct(state.book.maxParticipation, 1)} tone={state.book.maxParticipation > 0.101 ? 'text-[#f5c069]' : 'text-[#10B981]'} />
          </dl>
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right="live caps">Risk budget</SectionLabel>
          <RiskBudgetStrip live={state} />
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <AutonomyDial
            level={state.autonomy}
            regime={state.regime}
            ratchetArmed={ratchetArmed}
            onSet={onSetAutonomy}
            disabled={busy === 'autonomy'}
          />
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel>Actions</SectionLabel>
          <div className="flex flex-col gap-1.5">
            <Button
              size="sm"
              className="h-7 justify-start border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={onPoll}
              disabled={busy === 'poll'}
            >
              {busy === 'poll' ? <Loader2 size={12} className="animate-spin" style={{ animationDuration: '1.2s' }} /> : <RefreshCw size={12} strokeWidth={1.5} />}
              Poll news + prices
            </Button>
            <Button
              size="sm"
              className="h-7 justify-start border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-200 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={onRebalance}
              disabled={busy === 'rebalance' || !state.market.open}
              title={state.market.open ? 'Run the decision loop: news → radar → optimizer+AI advisor → constitution → critic → consent → execute' : state.market.reason}
            >
              {busy === 'rebalance' ? <Loader2 size={12} className="animate-spin" style={{ animationDuration: '1.2s' }} /> : <Zap size={12} strokeWidth={1.5} />}
              Rebalance now
            </Button>
            <Button
              size="sm"
              className="h-7 justify-start border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={onPostMortem}
              disabled={state.day === 0}
            >
              <ScrollText size={12} strokeWidth={1.5} /> Post-mortem
            </Button>
            <Button
              size="sm"
              className="h-7 justify-start border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-500 hover:bg-[#1c1710] hover:text-[#f5c069]"
              onClick={onStress}
              title="What-if pre-mortem: project today's book through a scripted crisis (buy-and-hold, no trades) — the counterfactual the governed loop refuses to ride"
            >
              <FlaskConical size={12} strokeWidth={1.5} /> Stress lens
            </Button>
            <Button
              size="sm"
              className="h-7 justify-start border border-[#26262b] bg-[#131317] px-2.5 text-[11px] text-zinc-500 hover:text-[#EF4444]"
              onClick={onReset}
              disabled={busy === 'reset'}
              title="Stop this paper book and start a fresh ₹1,000 Cr one"
            >
              <Square size={12} strokeWidth={1.5} /> New book
            </Button>
            <div className="hairline-t mt-1.5 grid grid-cols-2 gap-1.5 pt-2">
              <a
                href="/api/kavach/live/export?kind=trades"
                download
                className="num flex h-7 items-center justify-start gap-1.5 border border-[#26262b] bg-[#131317] px-2.5 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
                title="Blotter CSV — executed paper trades read back from the recorder (no parallel accounting)"
              >
                <Download size={11} strokeWidth={1.5} /> blotter .csv
              </a>
              <a
                href="/api/kavach/live/export?kind=recorder"
                download
                className="num flex h-7 items-center justify-start gap-1.5 border border-[#26262b] bg-[#131317] px-2.5 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
                title="The hash-chained evidence — JSONL, hashes intact"
              >
                <Download size={11} strokeWidth={1.5} /> recorder .jsonl
              </a>
              <a
                href="/api/kavach/live/export?kind=history"
                download
                className="num col-span-2 flex h-7 items-center justify-start gap-1.5 border border-[#26262b] bg-[#131317] px-2.5 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
                title="Daily book snapshots from SQLite — NAV/gross/cash/borrow/regime"
              >
                <Download size={11} strokeWidth={1.5} /> book history .csv
              </a>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-zinc-600">
            Educational paper simulation — it never places real orders. The news poll also runs on a
            15-minute cron (<span className="num">/api/cron/news</span>).
          </p>
        </div>

        <SessionHistory currentId={state.sessionId} refreshKey={sessionKey} />
      </div>

      {/* main column */}
      <div className="space-y-3">
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <div className="flex items-baseline justify-between pb-2">
            <span className="section-label">Live paper NAV — real marks, ₹1,000 Cr start</span>
            <span className="flex items-center gap-3 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><span className="inline-block h-px w-4 border-t border-solid border-zinc-100" /> NAV</span>
              <span className="flex items-center gap-1"><CircleDot size={8} className="text-[#F5A623]" /> rebalance</span>
            </span>
          </div>
          <LiveNavChart series={state.navSeries} rebalanceDay={state.lastRebalanceDay} />
          <div className="mt-1 hairline-t pt-1">
            <span className="section-label">Drawdown</span>
            <DrawdownStrip series={state.navSeries} />
          </div>
        </div>

        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <SectionLabel right={`GSEC/IGCORP/CRED marked to model`}>Book — six sleeves</SectionLabel>
          <BookTable values={state.book.values} prices={state.book.prices} markSource={state.book.markSource} perf={state.bucketPerf} />
          <p className="mt-2 text-[10px] leading-4 text-zinc-600">
            EQ and GOLD carry real market returns (Yahoo: ^NSEI, GC=F × USDINR). Indian bonds have no
            free tickers — those sleeves follow news-driven yield/spread factors, labeled MTM. LIQ
            accrues TREPS-style ~4% p.a. Trend = cumulative sleeve performance since start (day 0 =
            100), same marks as the ledger.
          </p>
        </div>

        {/* AI in context: advisor proposals inside the trade context, amber edge */}
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <div className="flex items-baseline justify-between pb-2">
            <span className="section-label">AI decision loop — Advisor proposals &amp; Critic challenges</span>
            <span className="num text-[10px] text-zinc-500">
              {state.ai.lastAdvisorOutcome === 'ok' ? 'advisor: LIVE' : `advisor: ${state.ai.lastAdvisorOutcome ?? 'idle'}`} ·{' '}
              {state.ai.lastCriticOutcome === 'ok' ? 'critic: LIVE' : `critic: ${state.ai.lastCriticOutcome ?? 'idle'}`}
            </span>
          </div>
          {aiAdvisor.length === 0 && aiCritic.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={14} strokeWidth={1.5} />}
              text={
                <span>
                  No AI decisions yet. The Advisor proposes trades (constitution-clipped before they are
                  viable — same A3/A4 caps as any deterministic trade); the Critic challenges the chosen
                  list and can only <span className="text-zinc-300">raise</span> the approval bar. Both are marked{' '}
                  <span className="text-[#f5c069]">amber</span> wherever they touch the loop. Zero authority — the
                  constitution disposes.
                </span>
              }
            />
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="hairline-b text-left">
                  <th className="w-24 pb-1.5 font-medium text-zinc-500">Origin</th>
                  <th className="pb-1.5 font-medium text-zinc-500">Proposal / concern</th>
                  <th className="w-28 pb-1.5 text-right font-medium text-zinc-500">₹ Cr</th>
                </tr>
              </thead>
              <tbody>
                {aiAdvisor.slice(-6).reverse().map((a, i) => (
                  <tr key={`adv-${i}`} className="border-l-2 border-[#F5A623] transition-colors duration-150 hover:bg-[#131317]">
                    <td className="num py-1.5 pl-2 pr-2 text-[11px] text-[#f5c069]">AI · d{a.day}</td>
                    <td className="py-1.5 pr-2">
                      <span className="num text-zinc-100">
                        {a.action.toUpperCase()} {a.bucket}
                      </span>
                      <span className="num ml-2 text-[10px] text-zinc-500">{a.note}</span>
                    </td>
                    <td className="num py-1.5 pr-2 text-right text-zinc-100">{a.valueCr.toFixed(2)}</td>
                  </tr>
                ))}
                {aiCritic.slice(-4).reverse().map((c, i) => (
                  <tr key={`cri-${i}`} className="border-l-2 border-[#8A5A1B] transition-colors duration-150 hover:bg-[#131317]">
                    <td className="num py-1.5 pl-2 pr-2 text-[11px] text-[#f5c069]">CRITIC · d{c.day}</td>
                    <td className="py-1.5 pr-2 text-zinc-300" colSpan={2}>
                      <span className="num mr-2 text-[10px] uppercase text-[#f5c069]">{c.verdict}</span>
                      {c.concern}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* the blotter: every executed leg, read back from the recorder */}
        <div className="border border-[#1F1F23] bg-[#101013] p-3">
          <TradeBlotter trades={state.trades} />
        </div>

        {auditOpen ? (
          <RecorderBrowser endpoint="/api/kavach/live/recorder" day={state.day} onClose={() => setAuditOpen(false)} />
        ) : (
          <RecorderStrip
            entries={state.recorder.entries}
            headHash={state.recorder.headHash}
            chainValid={state.recorder.chainValid}
            onExpand={() => setAuditOpen(true)}
          />
        )}
      </div>

      {/* right rail */}
      <div className="space-y-3">
        <RadarFeed events={state.radar} links={links} />
        <ApprovalsInbox cards={state.approvals} onDecide={onDecide} busy={busy === 'decide'} />
        <ConstitutionPanel checks={state.constitution} />
      </div>

      {pm && state ? <PostMortemSheetLive onClose={() => setPm(false)} onGenerate={onPostMortem} sessionId={state.sessionId} /> : null}
    </div>
  );
}

function PostMortemSheetLive({ onClose, onGenerate, sessionId }: { onClose: () => void; onGenerate: () => void; sessionId: string }) {
  const [md, setMd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api<{ postMortem: { markdown: string } | null }>(`/api/kavach/live/postmortem`);
        if (!cancelled) setMd(res.postMortem?.markdown ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[#1F1F23] bg-[#0D0D10] shadow-[0_-8px_24px_rgba(0,0,0,0.5)]">
      <div className="mx-auto max-w-6xl px-4 py-3">
        <div className="flex items-center justify-between pb-2">
          <span className="section-label">Live post-mortem — session {sessionId.slice(0, 10)}</span>
          <span className="flex items-center gap-2">
            {md ? (
              <Button
                size="sm"
                className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200"
                onClick={() => downloadText(`kavach-live-postmortem-${sessionId.slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8')}
                title="Download the post-mortem as markdown"
              >
                <Download size={12} strokeWidth={1.5} /> .md
              </Button>
            ) : null}
            <Button size="sm" className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200" onClick={onClose}>
              close (esc)
            </Button>
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto pr-2 scrollbar-terminal">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <Loader2 size={14} className="animate-spin" style={{ animationDuration: '1.2s' }} /> Reading the recorder…
            </div>
          ) : md ? (
            <MarkdownLite text={md} />
          ) : (
            <div className="text-[12px] text-zinc-500">
              No post-mortem yet.{' '}
              <button className="text-[#f5c069] underline decoration-dotted underline-offset-2" onClick={onGenerate}>
                Generate one
              </button>{' '}
              — the narrator reads the hash-chained recorder, cites real news events and AI provenance.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- header / status strip

// ---------------------------------------------------------------- stress lens (what-if pre-mortem)

const STRESS_CRISES: { id: string; label: string; days: number }[] = [
  { id: 'TANTRUM-13', label: 'TANTRUM ’13', days: 30 },
  { id: 'ILFS-18', label: 'IL&FS ’18', days: 45 },
  { id: 'COVID-20', label: 'COVID ’20', days: 30 },
];

function StressLensSheet({ onClose, initialCrisis }: { onClose: () => void; initialCrisis?: string }) {
  const [crisis, setCrisis] = useState(initialCrisis ?? 'TANTRUM-13');
  const [res, setRes] = useState<StressLensView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let stop = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const d = await api<StressLensView>(`/api/kavach/live/stress?scenario=${crisis}`);
        if (!stop) setRes(d);
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : 'stress lens failed');
      } finally {
        if (!stop) setLoading(false);
      }
    })();
    return () => {
      stop = true;
    };
  }, [crisis]);

  const startNav = res?.path?.[0]?.nav ?? 0;
  const stopNav = startNav * 0.9; // desk stop ≈ −10% from today

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[#1F1F23] bg-[#0D0D10] shadow-[0_-8px_24px_rgba(0,0,0,0.5)]" role="dialog" aria-modal="true" aria-label="stress lens — what-if pre-mortem">
      <div className="mx-auto max-w-6xl px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <span className="section-label">Stress lens — what if it happened to this book?</span>
          <div className="flex items-center gap-2">
            <div className="flex border border-[#26262b]" role="tablist" aria-label="crisis scenario">
              {STRESS_CRISES.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={crisis === c.id}
                  onClick={() => setCrisis(c.id)}
                  className={`num px-2 py-0.5 text-[10px] transition-colors duration-150 ${
                    crisis === c.id ? 'bg-[#1c1710] text-[#f5c069]' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                  title={`Project today's book through the scripted ${c.label} path (${c.days} days)`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <Button size="sm" className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200" onClick={onClose}>
              close (esc)
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="skeleton-row h-40 border border-[#1F1F23]" aria-label="projecting" />
        ) : err ? (
          <div className="py-4 text-[12px] text-[#EF4444]">{err}</div>
        ) : res ? (
          <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
            <div>
              <div className="h-[190px] w-full" data-testid="stress-chart">
                <ResponsiveContainer>
                  <ComposedChart data={res.path} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid horizontal vertical={false} {...GRID} />
                    <XAxis dataKey="day" tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }} tickLine={false} axisLine={{ stroke: '#1F1F23' }} minTickGap={24} />
                    <YAxis
                      domain={['auto', 'auto']}
                      tick={{ fill: '#52525B', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
                      tickLine={false}
                      axisLine={false}
                      width={62}
                      minTickGap={12}
                      tickFormatter={(v: number) => `${(v / CR).toFixed(0)}Cr`}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2A2A30', strokeWidth: 1 }} />
                    <ReferenceLine y={stopNav} stroke="#5A1F1F" strokeDasharray="3 3" ifOverflow="extendDomain" label={{ value: 'desk stop ≈ −10%', fill: '#7F7F87', fontSize: 9, fontFamily: 'var(--font-geist-mono)', position: 'insideBottomLeft' }} />
                    <ReferenceLine y={startNav} stroke="#2A2A30" strokeDasharray="2 4" ifOverflow="extendDomain" />
                    <Line type="monotone" dataKey="nav" name="UNMANAGED NAV" stroke="#F5A623" strokeWidth={1.5} dot={endDotFactory(res.path.length, '#F5A623')} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 hairline-t pt-1">
                <span className="section-label">Projected drawdown (unmanaged)</span>
                <DrawdownStrip series={res.path} />
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2">
                <div>
                  <div className="section-label">NAV today</div>
                  <div className="num text-[13px] text-zinc-100">{cr2(res.navStartCr)}</div>
                </div>
                <div>
                  <div className="section-label">At scripted close</div>
                  <div className="num text-[13px] text-zinc-100">{cr2(res.navEndCr)}</div>
                </div>
                <div>
                  <div className="section-label">Max DD</div>
                  <div className={`num text-[13px] ${res.maxDrawdown < -0.1 ? 'text-[#EF4444]' : res.maxDrawdown < -0.05 ? 'text-[#f5c069]' : 'text-zinc-100'}`}>{pct(res.maxDrawdown, 1)}</div>
                </div>
                <div>
                  <div className="section-label">Tail / day</div>
                  <div className={`num text-[13px] ${res.cvar95 > 0.015 ? 'text-[#f5c069]' : 'text-zinc-100'}`}>{pct(res.cvar95, 2)}</div>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-zinc-600">{res.honest}</p>
            </div>
            <div className="max-h-[420px] overflow-y-auto pr-1 scrollbar-terminal">
              <div className="space-y-1.5">
                {res.verdicts.map((v) => (
                  <div key={v.article} className={`border-l-2 py-1.5 pl-2.5 ${v.passed ? 'border-[#1f3a2a]' : 'border-[#EF4444]'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="num text-[10px] uppercase tracking-wider text-zinc-500">
                        {v.article} · {v.title}
                      </span>
                      <span className={`num flex items-center gap-1 text-[10px] ${v.passed ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                        {v.passed ? <BadgeCheck size={10} strokeWidth={1.5} /> : <AlertTriangle size={10} strokeWidth={1.5} />}
                        {v.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{v.detail}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 hairline-t pt-2">
                <span className="section-label">Sleeve damage · scripted cumulative</span>
                <div className="mt-1.5 space-y-1">
                  {BUCKETS.map((b) => {
                    const r = res.sleeveCum[b] ?? 0;
                    const w = Math.min(100, Math.abs(r) * 250); // 40% damage fills the bar
                    return (
                      <div key={b} className="flex items-center gap-2">
                        <span className="num w-16 shrink-0 text-[10px] text-zinc-500">{b}</span>
                        <span className="relative h-1 flex-1 bg-[#141417]">
                          <span className={`absolute inset-y-0 left-0 ${r >= 0 ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`} style={{ width: `${w}%` }} />
                        </span>
                        <span className={`num w-14 shrink-0 text-right text-[10px] ${tone(r)}`}>{sign(r * 100, 1)}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                Reference lines, not enforcement: the live constitution runs pre-trade on the managed loop — it would have cut
                gross and ratcheted autonomy along this path. This sheet deliberately shows the ride the bot refuses to take.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const cr2 = (x: number) => `₹${x.toFixed(1)} Cr`;

// ---------------------------------------------------------------- radar detail drawer

function RadarDetailSheet({ e, link, onClose }: { e: RadarEvent; link?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const isAi = e.provider === 'gemini' || e.provider === 'llm';
  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} role="presentation">
      <aside
        className="drawer-in absolute right-0 top-0 h-full w-[min(420px,100vw-24px)] overflow-y-auto border-l border-[#1F1F23] bg-[#0D0D10] p-4 scrollbar-terminal"
        role="dialog"
        aria-modal="true"
        aria-label="radar event detail"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-2">
          <span className="section-label">Radar event · day {e.day}</span>
          <Button size="sm" className="h-7 border border-[#26262b] bg-transparent px-2 text-zinc-400 hover:text-zinc-200" onClick={onClose}>
            close (esc)
          </Button>
        </div>
        <div className="flex items-start gap-2 pb-2">
          <SeverityChip sev={e.severity} />
          <span className="num text-[10px] uppercase tracking-wider text-zinc-600">{e.event}</span>
        </div>
        <p className="pb-3 text-[13px] leading-relaxed text-zinc-100">{e.headline}</p>
        <dl className="space-y-1.5 text-[12px]">
          <StatRow label="Severity" value={`${e.severity} / 5`} tone={e.severity >= 4 ? 'text-[#EF4444]' : e.severity === 3 ? 'text-[#f5c069]' : 'text-zinc-300'} />
          <StatRow label="Sleeves touched" value={e.buckets.length ? e.buckets.join(' · ') : 'none directly'} />
          <StatRow label="Direction" value={e.direction} />
          <StatRow label="Confidence" value={pct(e.confidence, 0)} />
          <StatRow label="Source" value={e.source} />
          <StatRow label="Classifier" value={isAi ? 'GEMINI (structured)' : 'DICTIONARY (zero-key)'} tone={isAi ? 'text-[#f5c069]' : 'text-zinc-300'} />
          {e.latencyMs != null ? <StatRow label="Latency" value={`${e.latencyMs} ms`} /> : null}
          <StatRow label="A7 effect" value={e.applied ? 'TIGHTENED — risk limits moved one notch' : 'inert (below threshold)'} tone={e.applied ? 'text-[#10B981]' : 'text-zinc-500'} />
        </dl>
        <p className="mt-3 text-[10px] leading-4 text-zinc-600">
          Every radar reading is advisory only: the governor treats it as pressure on the regime machine — severity ≥ 4
          ratchets autonomy one notch. Headlines are HTML-escaped before they reach any model or the DOM; the classifier
          may never loosen a limit (A7).
        </p>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="num mt-3 flex items-center gap-1.5 border border-[#26262b] px-2 py-1 text-[11px] text-zinc-300 transition-colors duration-150 hover:bg-[#1c1710] hover:text-[#f5c069]"
          >
            <Link2 size={11} strokeWidth={1.5} /> open source article ↗
          </a>
        ) : (
          <p className="mt-3 text-[10px] text-zinc-600">No source link on this event (replay-scripted headline).</p>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- keyboard shortcuts sheet

const SHORTCUTS: { keys: string; what: string; when: string }[] = [
  { keys: '⌘K / ctrl K', what: 'Command palette — every console action', when: 'anywhere' },
  { keys: '?', what: 'Open the palette (same thing, one key)', when: 'anywhere' },
  { keys: '/', what: 'This shortcuts sheet', when: 'anywhere' },
  { keys: 'space', what: 'Play / pause the crisis replay', when: 'REPLAY LAB' },
  { keys: '→ / ←', what: 'Step one day forward / back', when: 'REPLAY LAB' },
  { keys: '1 · 2 · 3', what: 'Start Taper Tantrum / IL&FS / COVID', when: 'REPLAY LAB' },
  { keys: 'L', what: 'Toggle LIVE PAPER (with confirmation)', when: 'anywhere' },
  { keys: 'esc', what: 'Close any sheet, drawer or palette', when: 'any sheet open' },
];

function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} role="presentation">
      <div
        className="palette-in fixed left-1/2 top-[16%] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 border border-[#1F1F23] bg-[#101013] shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
        role="dialog"
        aria-modal="true"
        aria-label="keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1F1F23] px-3 py-2">
          <span className="section-label">Keyboard shortcuts</span>
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="px-3 py-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-3 border-b border-[#161619] py-2 last:border-0">
              <kbd className="kbd shrink-0">{s.keys}</kbd>
              <span className="min-w-0 flex-1 text-[12px] text-zinc-300">{s.what}</span>
              <span className="num shrink-0 text-[9px] uppercase tracking-wider text-zinc-600">{s.when}</span>
            </div>
          ))}
        </div>
        <p className="border-t border-[#1F1F23] px-3 py-2 text-[10px] leading-4 text-zinc-600">
          The desk is keyboard-first: a stranger should be able to drive the whole console without touching a mouse. Every
          action still lands in the hash-chained flight recorder.
        </p>
      </div>
    </div>
  );
}

function StatusBar({ replay, live, mode }: { replay: ReplayState | null; live: LiveState | null; mode: 'replay' | 'live' }) {
  const regime = mode === 'live' ? live?.regime : replay?.bots?.['governed']?.regime ?? 'CALM';
  const autonomy = mode === 'live' ? live?.autonomy : replay?.autonomy;
  const badge = mode === 'live' ? (live?.providers.badge ?? 'DICT') : replay?.llmRadar ? 'GEMINI' : 'DICT';
  const budget = live?.providers.budget;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span className="num border border-[#26262b] bg-[#131317] px-1.5 py-px text-zinc-300">{mode === 'live' ? 'LIVE PAPER' : 'REPLAY LAB'}</span>
      <span className="num text-zinc-500">
        regime <span className={REGIME_TONE[regime ?? 'CALM'] ?? 'text-zinc-300'}>{regime ?? 'CALM'}</span>
      </span>
      <span className="num text-zinc-500">
        autonomy <span className="text-zinc-300">{autonomy ?? 'FULL'}</span>
      </span>
      <ProviderChip badge={badge} />
      {budget ? (
        <span className="num flex items-center gap-1.5 text-zinc-500" title="Real Gemini network calls today vs the daily budget — nokey/dictionary calls are free and don't count (persisted in SQLite)">
          budget
          <span className="relative inline-block h-1 w-14 border border-[#26262b] bg-[#0D0D10]" aria-hidden>
            <span
              className={`absolute inset-y-0 left-0 transition-[width] duration-200 ${budget.used >= budget.limit ? 'bg-[#F5A623]' : 'bg-zinc-400'}`}
              style={{ width: `${Math.min(100, Math.max(2, (budget.used / budget.limit) * 100))}%` }}
            />
          </span>
          <span className={budget.used >= budget.limit ? 'text-[#f5c069]' : 'text-zinc-300'}>
            {budget.used}/{budget.limit}
          </span>
        </span>
      ) : null}
      {mode === 'live' && live ? (
        <span className="num text-zinc-500">
          market{' '}
          <span className={live.market.open ? 'text-[#10B981]' : 'text-zinc-400'}>{live.market.open ? 'OPEN' : 'CLOSED'}</span>
          {live.providers.news.degraded ? <span className="ml-2 text-[#f5c069]">NEWS FEED DEGRADED</span> : null}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function Page() {
  const [mode, setMode] = useState<'replay' | 'live'>('replay');
  const [confirmLive, setConfirmLive] = useState(false);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [deciding, setDeciding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const [marginDays, setMarginDays] = useState<Set<number>>(new Set());
  const [rbiDay, setRbiDay] = useState<number | null>(null);
  const [ratchetArmed, setRatchetArmed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [stress, setStress] = useState<{ open: boolean; crisis: string }>({ open: false, crisis: 'TANTRUM-13' });
  const [sessionKey, setSessionKey] = useState(0);

  const notify = useCallback((text: string, tone: 'ok' | 'warn' | 'err' = 'ok') => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 4200);
  }, []);

  // ---- replay poll
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api<ReplayState>('/api/kavach/state');
        if (!stop) setReplay(d.active ? d : { ...d, active: false });
      } catch {
        /* transient */
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);

  // ---- autoplay
  useEffect(() => {
    if (!playing || mode !== 'replay') return;
    if (replay?.complete) {
      setPlaying(false);
      return;
    }
    const iv = setInterval(async () => {
      try {
        await api('/api/kavach/replay/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      } catch {
        setPlaying(false);
      }
    }, 1000 / speed);
    return () => clearInterval(iv);
  }, [playing, speed, mode, replay?.complete]);

  // ---- live poll (12s in live mode; 60s otherwise to stay warm)
  useEffect(() => {
    if (mode !== 'live') return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await api<{ live: LiveState }>('/api/kavach/live/state');
        if (!stop && d.live) setLive(d.live);
      } catch {
        /* transient */
      }
    };
    tick();
    const iv = setInterval(tick, 12_000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [mode]);

  // ---- margin-call day markers (replay) from the recorder
  useEffect(() => {
    if (mode !== 'replay' || !replay?.active) return;
    const day = replay.day;
    const scenario = replay.scenario?.id;
    let stop = false;
    (async () => {
      try {
        const d = await api<{ entries: { day: number; kind: string }[] }>(
          `/api/kavach/flightrecorder?from=0&to=${day}&bot=governed&limit=500`
        );
        if (stop) return;
        setMarginDays(new Set(d.entries.filter((e) => e.kind === 'MARGIN_CALL' || e.kind === 'FORCED_SALE').map((e) => e.day)));
        setRbiDay(scenario === 'COVID-20' ? 14 : scenario === 'TANTRUM-13' ? 21 : null);
      } catch {
        /* markers are optional evidence */
      }
    })();
    return () => {
      stop = true;
    };
  }, [mode, replay?.active, replay?.day, replay?.scenario?.id, replay?.complete]);

  // ---- actions
  const startReplay = useCallback(
    async (id: string) => {
      try {
        setPlaying(false);
        setMarginDays(new Set());
        await api('/api/kavach/replay/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenario: id, mode: 'both' }),
        });
        notify(`${id} — A/B replay started (seed 42)`);
      } catch (e) {
        notify(e instanceof Error ? e.message : 'replay failed', 'err');
      }
    },
    [notify]
  );

  const stepReplay = useCallback(async (n: number) => {
    try {
      await api('/api/kavach/replay/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: n }),
      });
    } catch {
      /* transient */
    }
  }, []);

  const decideReplay = useCallback(
    async (id: string, decision: 'APPROVED' | 'REJECTED') => {
      setDeciding(true);
      try {
        const res = await api<{ ok: boolean; note?: string }>(`/api/kavach/governor/approve/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        notify(res.ok ? `${id} ${decision.toLowerCase()} — executed within A3, recorded` : `${id}: ${res.note ?? 'not applied'}`, res.ok ? 'ok' : 'warn');
      } catch (e) {
        notify(e instanceof Error ? e.message : 'decision failed', 'err');
      } finally {
        setDeciding(false);
      }
    },
    [notify]
  );

  const setReplayAutonomy = useCallback(
    async (level: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE') => {
      try {
        const res = await api<{ ok: boolean; autonomy?: string; ratchetArmed?: boolean; note?: string }>('/api/kavach/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autonomy: level }),
        });
        setRatchetArmed(Boolean(res.ratchetArmed));
        notify(
          res.ok ? `Autonomy → ${res.autonomy ?? level}${res.ratchetArmed ? ' (ratchet armed: one-way from here)' : ''}` : res.note ?? 'ratchet blocked this move',
          res.ok ? 'ok' : 'warn'
        );
      } catch (e) {
        notify(e instanceof Error ? e.message : 'mode change failed', 'err');
      }
    },
    [notify]
  );

  const setLiveAutonomy = useCallback(
    async (level: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE') => {
      setBusy('autonomy');
      try {
        const res = await api<{ ok: boolean; autonomy?: string; ratchetArmed?: boolean; note?: string; live?: LiveState }>(
          '/api/kavach/live/mode',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autonomy: level }),
          }
        );
        setRatchetArmed(Boolean(res.ratchetArmed));
        if (res.live) setLive(res.live);
        notify(
          res.ok ? `Autonomy → ${res.autonomy ?? level}${res.ratchetArmed ? ' (ratchet armed: one-way from here)' : ''} — recorded in the flight recorder` : res.note ?? 'ratchet blocked this move',
          res.ok ? 'ok' : 'warn'
        );
      } catch (e) {
        notify(e instanceof Error ? e.message : 'mode change failed', 'err');
      } finally {
        setBusy(null);
      }
    },
    [notify]
  );

  const generatePostMortem = useCallback(async () => {
    try {
      await api('/api/kavach/narrator/postmortem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      notify('Post-mortem generated from the flight recorder');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'narrator failed', 'err');
    }
  }, [notify]);

  const livePoll = useCallback(async () => {
    setBusy('poll');
    try {
      await api('/api/kavach/live/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await api<{ live: LiveState }>('/api/kavach/live/state');
      setLive(d.live);
      notify('Polled: prices (10-min cache) + news (15-min TTL) + radar');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'poll failed', 'err');
    } finally {
      setBusy(null);
    }
  }, [notify]);

  const liveRebalance = useCallback(async () => {
    setBusy('rebalance');
    try {
      const res = await api<{ ok: boolean; reason?: string; trades: number }>('/api/kavach/live/rebalance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.ok) notify(`Rebalance complete — ${res.trades} trade(s) executed through the impact model, all recorded`);
      else notify(res.reason ?? 'rebalance blocked', 'warn');
      const d = await api<{ live: LiveState }>('/api/kavach/live/state');
      setLive(d.live);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'rebalance failed', 'err');
    } finally {
      setBusy(null);
    }
  }, [notify]);

  const liveDecide = useCallback(
    async (id: string, decision: 'APPROVED' | 'REJECTED') => {
      setBusy('decide');
      try {
        await api(`/api/kavach/live/approve/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        notify(`${id} ${decision.toLowerCase()} (durable queue — survived restarts)`);
        const d = await api<{ live: LiveState }>('/api/kavach/live/state');
        setLive(d.live);
      } catch (e) {
        notify(e instanceof Error ? e.message : 'decision failed', 'err');
      } finally {
        setBusy(null);
      }
    },
    [notify]
  );

  const livePostMortem = useCallback(async () => {
    try {
      await api('/api/kavach/live/postmortem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch {
      /* template fallback is fine */
    }
  }, []);

  const liveReset = useCallback(async () => {
    setBusy('reset');
    try {
      await api('/api/kavach/live/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fresh: true }),
      });
      const d = await api<{ live: LiveState }>('/api/kavach/live/state');
      setLive(d.live);
      setSessionKey((k) => k + 1);
      notify('Fresh ₹1,000 Cr paper book opened — the old session is stopped and recorded');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'reset failed', 'err');
    } finally {
      setBusy(null);
    }
  }, [notify]);

  const enterLive = useCallback(() => {
    setConfirmLive(false);
    setMode('live');
    (async () => {
      try {
        const d = await api<{ live: LiveState }>('/api/kavach/live/state');
        setLive(d.live);
      } catch {
        /* will retry on poll */
      }
    })();
  }, []);

  const openStress = useCallback((crisis: string) => {
    setMode('live');
    setStress({ open: true, crisis });
  }, []);

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (mode === 'replay') setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight') {
        if (mode === 'replay') void stepReplay(1);
      } else if (e.key === 'ArrowLeft') {
        if (mode === 'replay') void stepReplay(-1);
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
        if (mode === 'replay') {
          const s = SCENARIOS.find((x) => x.key === e.key);
          if (s) void startReplay(s.id);
        }
      } else if (e.key === 'l' || e.key === 'L') {
        if (mode === 'replay') setConfirmLive(true);
        else setMode('replay');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, startReplay, stepReplay]);

  // ---- markers for the hero chart
  const markers: Marker[] = useMemo(() => {
    const out: Marker[] = [];
    const radarDays = (replay?.bots?.['governed']?.radarFeed ?? []).filter((r) => r.severity >= 3).map((r) => r.day);
    for (const d of new Set(radarDays)) out.push({ day: d, nav: 0, kind: 'radar', label: 'radar' });
    for (const d of marginDays) out.push({ day: d, nav: 0, kind: 'margin', label: 'margin' });
    if (rbiDay != null) out.push({ day: rbiDay, nav: 0, kind: 'rbi', label: 'policy' });
    return out;
  }, [replay, marginDays, rbiDay]);

  // ---- ⌘K command palette: every console action, keyboard-first
  const commands: Cmd[] = useMemo(() => {
    const replayCmds: Cmd[] = [
      ...SCENARIOS.map((s) => ({
        id: `scenario-${s.id}`,
        label: `Replay ${s.title} (${s.tag.toLowerCase()}, ${s.days}d)`,
        hint: s.key,
        group: 'crisis',
        run: () => void startReplay(s.id),
      })),
      { id: 'play', label: playing ? 'Pause the replay' : 'Play the replay (1 day/sec)', hint: 'space', group: 'replay', run: () => setPlaying((p) => !p) },
      { id: 'step', label: 'Step one day', hint: '→', group: 'replay', run: () => void stepReplay(1) },
      { id: 'end', label: 'Run to the end', group: 'replay', run: () => void stepReplay(999) },
      { id: 'postmortem', label: 'Generate the post-mortem', group: 'replay', run: () => void generatePostMortem() },
      { id: 'eq-csv', label: 'Export A/B equity curves (.csv)', group: 'export', run: () => window.open('/api/kavach/replay/export?kind=equity', '_blank') },
      { id: 'eq-jsonl', label: 'Export governed recorder (.jsonl)', group: 'export', run: () => window.open('/api/kavach/replay/export?kind=recorder&bot=governed', '_blank') },
      { id: 'go-live', label: 'Switch to LIVE PAPER (real data)', hint: 'L', group: 'mode', run: () => setConfirmLive(true) },
    ];
    const liveCmds: Cmd[] = [
      { id: 'poll', label: 'Poll news + prices now', group: 'live', run: () => void livePoll() },
      { id: 'rebalance', label: 'Rebalance now (market-hours gated)', group: 'live', run: () => void liveRebalance() },
      { id: 'stress-tantrum', label: 'Stress lens: TANTRUM-13 on this book', group: 'lens', run: () => openStress('TANTRUM-13') },
      { id: 'stress-ilfs', label: 'Stress lens: IL&FS-18 on this book', group: 'lens', run: () => openStress('ILFS-18') },
      { id: 'stress-covid', label: 'Stress lens: COVID-20 on this book', group: 'lens', run: () => openStress('COVID-20') },
      { id: 'live-pm', label: 'Open the live post-mortem', group: 'live', run: () => void livePostMortem() },
      { id: 'live-new', label: 'New ₹1,000 Cr paper book', group: 'live', run: () => void liveReset() },
      { id: 'blotter-csv', label: 'Export session blotter (.csv)', group: 'export', run: () => window.open('/api/kavach/live/export?kind=trades', '_blank') },
      { id: 'hist-csv', label: 'Export book history (.csv)', group: 'export', run: () => window.open('/api/kavach/live/export?kind=history', '_blank') },
      { id: 'live-jsonl', label: 'Export recorder evidence (.jsonl)', group: 'export', run: () => window.open('/api/kavach/live/export?kind=recorder', '_blank') },
      { id: 'go-replay', label: 'Switch to REPLAY LAB', hint: 'L', group: 'mode', run: () => setMode('replay') },
    ];
    const common: Cmd[] = [
      { id: 'palette', label: 'Show this palette', hint: '?', group: 'help', run: () => setPaletteOpen(true) },
      { id: 'shortcuts', label: 'Keyboard shortcuts', hint: '/', group: 'help', run: () => setShortcutsOpen(true) },
    ];
    return [...(mode === 'replay' ? replayCmds : liveCmds), ...common];
  }, [mode, playing, startReplay, stepReplay, generatePostMortem, livePoll, liveRebalance, livePostMortem, liveReset, openStress]);

  return (
    <div className="flex min-h-screen flex-col bg-[#09090B] text-zinc-100">
      {/* header */}
      <header className="hairline-b sticky top-0 z-40 bg-[#09090B]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Shield size={16} strokeWidth={1.5} className="text-[#F5A623]" />
            <div className="leading-none">
              <div className="text-[15px] font-medium tracking-tight text-zinc-50">KAVACH</div>
              <div className="num text-[10px] text-zinc-500">event-aware capital governor · INR</div>
            </div>
          </div>
          <div className="flex border border-[#26262b]">
            <button
              onClick={() => setMode('replay')}
              className={`px-2.5 py-1 text-[11px] transition-colors duration-150 ${mode === 'replay' ? 'bg-[#1c1710] text-[#f5c069]' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="Three deterministic crisis A/B replays (seed 42)"
            >
              REPLAY LAB
            </button>
            <button
              onClick={() => (mode === 'live' ? undefined : setConfirmLive(true))}
              className={`px-2.5 py-1 text-[11px] transition-colors duration-150 ${mode === 'live' ? 'bg-[#1c1710] text-[#f5c069]' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="Live paper book on real data (L)"
            >
              LIVE PAPER
            </button>
          </div>
          <div className="ml-auto">
            <StatusBar replay={replay?.active ? replay : null} live={live} mode={mode} />
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            className="num flex items-center gap-1.5 border border-[#26262b] bg-[#131317] px-2 py-1 text-[10px] text-zinc-400 transition-colors duration-150 hover:text-[#f5c069]"
            title="Command palette — every console action (⌘K or ?)"
            aria-keyshortcuts="Control+K"
          >
            <Command size={11} strokeWidth={1.5} /> <kbd className="kbd border-0 bg-transparent p-0">⌘K</kbd>
          </button>
        </div>
      </header>

      {/* body */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4">
        {mode === 'replay' ? (
          <ReplayLab
            state={replay?.active ? replay : null}
            playing={playing}
            setPlaying={setPlaying}
            onStart={startReplay}
            onStep={stepReplay}
            speed={speed}
            setSpeed={setSpeed}
            onDecide={decideReplay}
            deciding={deciding}
            onPostMortem={generatePostMortem}
            onSetAutonomy={setReplayAutonomy}
            ratchetArmed={ratchetArmed}
            markers={markers}
          />
        ) : (
          <LivePaper
            state={live}
            busy={busy}
            onPoll={livePoll}
            onRebalance={liveRebalance}
            onDecide={liveDecide}
            onPostMortem={livePostMortem}
            onReset={liveReset}
            onSetAutonomy={setLiveAutonomy}
            onStress={() => setStress({ open: true, crisis: stress.crisis })}
            ratchetArmed={ratchetArmed}
            sessionKey={sessionKey}
          />
        )}
      </main>

      {/* footer — sticky bottom */}
      <footer className="hairline-t mt-auto bg-[#0C0C0E]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[10px] text-zinc-600">
          <span className="flex items-center gap-1">
            <ShieldAlert size={10} strokeWidth={1.5} className="text-zinc-600" />
            Educational simulation · never places real orders · not investment advice
          </span>
          <span className="num">NAV ≡ cash + Σ units×price + posted − borrowings (checked daily, ≤1e-8)</span>
          <span className="num">AI proposes · constitution disposes · recorder remembers</span>
          <span className="num ml-auto hidden items-center gap-2 sm:flex">
            <span className="flex items-center gap-1"><kbd className="kbd">⌘K</kbd> palette</span>
            <span className="flex items-center gap-1"><kbd className="kbd">/</kbd> keys</span>
            <span className="flex items-center gap-1"><kbd className="kbd">space</kbd> play</span>
            <span className="flex items-center gap-1"><kbd className="kbd">→</kbd> step</span>
            <span className="flex items-center gap-1"><kbd className="kbd">1·2·3</kbd> crisis</span>
            <span className="flex items-center gap-1"><kbd className="kbd">L</kbd> live</span>
          </span>
        </div>
      </footer>

      {/* confirm-on-live modal */}
      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent className="max-w-md border border-[#1F1F23] bg-[#101013]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[15px] text-zinc-100">
              <Radio size={15} strokeWidth={1.5} className="text-[#F5A623]" /> Switch on LIVE PAPER?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-relaxed text-zinc-400">
              In plain words:
            </AlertDialogDescription>
            <div className="mt-1.5 space-y-1.5 text-[12px] leading-relaxed text-zinc-400">
              <div className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                <span>
                  This is a <span className="text-zinc-200">paper book</span> — a ₹1,000 Cr portfolio marked to real
                  market prices and real news. <span className="text-zinc-200">No real orders are ever placed.</span>
                </span>
              </div>
              <div className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                <span>
                  It is <span className="text-zinc-200">not investment advice</span> — it is educational risk
                  engineering, demonstrated live.
                </span>
              </div>
              <div className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                <span>
                  Gemini (when a key is present) reads headlines and proposes/challenges trades with{' '}
                  <span className="text-zinc-200">zero authority</span> — the constitution still disposes, and the
                  dictionary fallback keeps everything running without any key.
                </span>
              </div>
              <div className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                <span>
                  Your replay is preserved: the A/B crisis lab is one keypress (<span className="num">esc</span> or the
                  toggle) away.
                </span>
              </div>
            </div>
            <AlertDialogFooter className="mt-2">
              <AlertDialogCancel className="h-8 border border-[#26262b] bg-[#131317] px-3 text-[12px] text-zinc-300 hover:bg-[#1c1710] hover:text-zinc-100">
                Stay in the lab
              </AlertDialogCancel>
              <AlertDialogAction
                className="h-8 border border-[#3a2d14] bg-[#1c1710] px-3 text-[12px] text-[#f5c069] hover:bg-[#2a2113]"
                onClick={enterLive}
              >
                <ArrowRight size={12} strokeWidth={1.5} /> Open the live paper book
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>

      {/* ⌘K command palette */}
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} commands={commands} /> : null}
      {shortcutsOpen ? <ShortcutsSheet onClose={() => setShortcutsOpen(false)} /> : null}
      {stress.open ? <StressLensSheet initialCrisis={stress.crisis} onClose={() => setStress((s) => ({ ...s, open: false }))} /> : null}

      {/* toast */}
      {toast ? (
        <div
          className={`toast-in fixed bottom-12 left-1/2 z-50 -translate-x-1/2 border px-3 py-2 text-[12px] ${
            toast.tone === 'ok'
              ? 'border-[#1f3a2a] bg-[#0d1512] text-[#10B981]'
              : toast.tone === 'warn'
                ? 'border-[#3a2d14] bg-[#171310] text-[#f5c069]'
                : 'border-[#3a1f1f] bg-[#150f10] text-[#EF4444]'
          }`}
          role="status"
        >
          <span className="flex items-center gap-2">
            {toast.tone === 'ok' ? <TrendingUp size={12} strokeWidth={1.5} /> : toast.tone === 'warn' ? <AlertTriangle size={12} strokeWidth={1.5} /> : <TrendingDown size={12} strokeWidth={1.5} />}
            {toast.text}
          </span>
        </div>
      ) : null}
    </div>
  );
}
