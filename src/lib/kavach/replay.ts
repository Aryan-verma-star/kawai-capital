/**
 * KAVACH — ReplayController: drives 1–2 SimSessions in lockstep (same seed,
 * same world) for the A/B demo: naive vs governed, the only difference being
 * the constitution. Also owns the narrator post-mortem cache.
 */

import { SimSession, BotSnapshot } from './sim';
import { SCENARIOS } from './world/scenarios';
import { AgentMode, AutonomyLevel, RadarEvent, ScenarioId } from './types';
import { llmPostMortem, templatePostMortem } from './llm/narrator';
import { CR } from './constants';
import { ApprovalCard, RecorderEntry } from './types';
import { fmt_inr } from './format';

export interface ReplayStartOptions {
  scenario: ScenarioId;
  mode: 'naive' | 'governed' | 'both';
  seed?: number;
  autonomy?: AutonomyLevel;
  llmRadar?: boolean;
}

export interface ReplayState {
  scenario: { id: ScenarioId; title: string; story: string; days: number };
  day: number;
  complete: boolean;
  mode: string;
  seed: number;
  autonomy: AutonomyLevel;
  llmRadar: boolean;
  fx: number;
  yieldLevel: number;
  headline: { day: number; text: string } | null;
  headlines: { day: number; text: string }[];
  bots: Partial<Record<AgentMode, BotSnapshot>>;
  postMortem: { markdown: string; provider: 'llm' | 'template'; latencyMs: number } | null;
  recorderSize: { naive: number; governed: number; world: number };
  recorderHead: { naive: string; governed: string; world: string };
}

export class ReplayController {
  scenario: ScenarioId;
  seed: number;
  sessions: Partial<Record<AgentMode, SimSession>> = {};
  mode: 'naive' | 'governed' | 'both';
  llmRadar: boolean;
  complete = false;
  startedAt = Date.now();
  postMortem: { markdown: string; provider: 'llm' | 'template'; latencyMs: number } | null = null;
  generatingPostMortem = false;

  constructor(opts: ReplayStartOptions) {
    this.scenario = opts.scenario;
    this.seed = opts.seed ?? 42;
    this.mode = opts.mode;
    this.llmRadar = opts.llmRadar ?? false;
    const make = (m: AgentMode) =>
      new SimSession({
        scenario: opts.scenario,
        mode: m,
        seed: this.seed,
        autonomy: opts.autonomy ?? 'FULL',
        llmRadar: this.llmRadar && m === 'governed',
        runTag: 'replay',
      });
    if (opts.mode === 'naive') this.sessions['naive'] = make('naive');
    else if (opts.mode === 'governed') this.sessions['governed'] = make('governed');
    else {
      this.sessions['naive'] = make('naive');
      this.sessions['governed'] = make('governed');
    }
  }

  get governed(): SimSession | null {
    return this.sessions['governed'] ?? null;
  }

  get day(): number {
    return Math.max(...Object.values(this.sessions).map((s) => s!.day));
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.complete) break;
      for (const s of Object.values(this.sessions)) s!.step();
      if (Object.values(this.sessions).every((s) => s!.complete)) {
        this.complete = true;
      }
    }
  }

  runToEnd(): void {
    this.step(999);
  }

  setAutonomy(level: AutonomyLevel): boolean {
    const g = this.governed?.governed;
    if (!g) return false;
    return g.autonomy.setLevel(level, this.day);
  }

  decide(id: string, decision: 'APPROVED' | 'REJECTED'): boolean {
    const sess = this.governed;
    const g = sess?.governed;
    if (!sess || !g) return false;
    return g.decide(id, decision, sess.engine, (kind, payload, meta) =>
      sess.recorder.record(sess.day, kind, payload, meta)
    );
  }

  recorderRange(bot: AgentMode, from: number, to: number): RecorderEntry[] {
    return this.sessions[bot]?.recorder.range(from, to) ?? [];
  }

  async generatePostMortem(useLlm = true): Promise<ReplayState['postMortem']> {
    if (this.postMortem) return this.postMortem;
    if (this.generatingPostMortem) return null;
    this.generatingPostMortem = true;
    try {
      const scenario = SCENARIOS[this.scenario];
      const input = {
        scenario: this.scenario,
        story: scenario.story,
        days: scenario.days,
        naive: this.sessions['naive']
          ? {
              navEnd: this.sessions['naive'].engine.nav(),
              maxDrawdown: this.sessions['naive'].metrics.maxDrawdown(),
              impactPaid: this.sessions['naive'].engine.impactPaid,
              forcedSaleEvents: this.sessions['naive'].engine.forcedSaleEvents,
              maxParticipation: this.sessions['naive'].engine.maxParticipation,
              marginCumulative: this.sessions['naive'].engine.marginCumulative,
            }
          : undefined,
        governed: this.sessions['governed']
          ? {
              navEnd: this.sessions['governed'].engine.nav(),
              maxDrawdown: this.sessions['governed'].metrics.maxDrawdown(),
              impactPaid: this.sessions['governed'].engine.impactPaid,
              forcedSaleEvents: this.sessions['governed'].engine.forcedSaleEvents,
              maxParticipation: this.sessions['governed'].engine.maxParticipation,
              marginCumulative: this.sessions['governed'].engine.marginCumulative,
              articleFired: (this.sessions['governed'].governed?.articleFired ?? []).map((f) => ({
                day: f.day,
                article: f.article,
                detail: f.detail,
              })),
              regimePath: this.sessions['governed'].observations.map((o) => o.regime),
              approvalsApproved: (this.sessions['governed'].governed?.consent.all() ?? []).filter(
                (c) => c.status === 'APPROVED'
              ).length,
              approvalsRejected: (this.sessions['governed'].governed?.consent.all() ?? []).filter(
                (c) => c.status === 'REJECTED'
              ).length,
              approvalsTimedOut: (this.sessions['governed'].governed?.consent.all() ?? []).filter(
                (c) => c.status === 'TIMEOUT'
              ).length,
            }
          : undefined,
      };
      if (useLlm) {
        const res = await llmPostMortem(input);
        this.postMortem = {
          markdown: res.markdown,
          provider: res.ok ? 'llm' : 'template',
          latencyMs: res.latencyMs,
        };
      } else {
        this.postMortem = { markdown: templatePostMortem(input), provider: 'template', latencyMs: 0 };
      }
      return this.postMortem;
    } finally {
      this.generatingPostMortem = false;
    }
  }

  state(): ReplayState {
    const scenario = SCENARIOS[this.scenario];
    const day = this.day;
    const fxAt = (d: number) => {
      const path = scenario.fxPath;
      let v = path[0].ret;
      for (const a of path) if (d >= a.day) v = a.ret;
      return v;
    };
    const yAt = (d: number) => {
      const path = scenario.yieldPath;
      let v = path[0].ret;
      for (const a of path) if (d >= a.day) v = a.ret;
      return v;
    };
    const headline = scenario.headlines.find((h) => h.day === day) ?? null;
    const bots: Partial<Record<AgentMode, BotSnapshot>> = {};
    for (const [k, s] of Object.entries(this.sessions)) {
      bots[k as AgentMode] = s!.snapshot();
    }
    return {
      scenario: { id: this.scenario, title: scenario.title, story: scenario.story, days: scenario.days },
      day,
      complete: this.complete,
      mode: this.mode,
      seed: this.seed,
      autonomy: this.governed?.governed?.autonomy.level ?? 'FULL',
      llmRadar: this.llmRadar,
      fx: fxAt(Math.min(day, scenario.days)),
      yieldLevel: yAt(Math.min(day, scenario.days)),
      headline,
      headlines: scenario.headlines,
      bots,
      postMortem: this.postMortem,
      recorderSize: {
        naive: this.sessions['naive']?.recorder.size() ?? 0,
        governed: this.sessions['governed']?.recorder.size() ?? 0,
        world: 0,
      },
      recorderHead: {
        naive: this.sessions['naive']?.recorder.headHash() ?? '',
        governed: this.sessions['governed']?.recorder.headHash() ?? '',
        world: '',
      },
    };
  }
}

export function abHeadline(state: ReplayState): string | null {
  const n = state.bots['naive'];
  const g = state.bots['governed'];
  if (!n || !g || !state.complete) return null;
  const d = g.nav - n.nav;
  return (
    `NaiveBot: ${fmt_inr(n.nav - n.navSeries[0].nav)}, ${n.cascadeDays} forced-sale cascade days. ` +
    `KAVACH: ${fmt_inr(g.nav - g.navSeries[0].nav)}, ${g.redemptionsMissed} redemptions missed, ` +
    `participation never exceeded 10% ADV (${(g.maxParticipation * 100).toFixed(1)}% peak). ` +
    `Difference: ${d >= 0 ? '+' : ''}₹${(d / CR).toFixed(0)} Cr.`
  );
}

export interface PendingApproval extends ApprovalCard {
  counterfactualText: string;
}

export function pendingApprovalsOf(state: ReplayState): ApprovalCard[] {
  return state.bots['governed']?.approvals.filter((a) => a.status === 'PENDING') ?? [];
}

export function radarFeedOf(state: ReplayState): RadarEvent[] {
  return state.bots['governed']?.radarFeed ?? [];
}
