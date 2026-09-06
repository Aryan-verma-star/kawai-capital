/**
 * KAVACH — Narrator. Post-mortem prose, zero control flow.
 * After a run, reads the flight recorder + headline stats and writes a
 * markdown post-mortem via Gemini. It must cite real news events and
 * AI-decision provenance when present (LIVE), never invent numbers (the
 * deterministic template is passed as ground truth), and close with the
 * house line. Falls back to the template on any failure.
 */

import { CR as CRORE } from '../constants';
import { fmt_inr, fmt_pct } from '../format';
import { ScenarioId } from '../types';
import { geminiStructured } from './gemini';
import { z } from 'zod';

export interface NarratorInput {
  scenario: ScenarioId;
  story: string;
  days: number;
  naive?: {
    navEnd: number;
    maxDrawdown: number;
    impactPaid: number;
    forcedSaleEvents: number;
    maxParticipation: number;
    marginCumulative: number;
  };
  governed?: {
    navEnd: number;
    maxDrawdown: number;
    impactPaid: number;
    forcedSaleEvents: number;
    maxParticipation: number;
    marginCumulative: number;
    articleFired: { day: number; article: string; detail: string }[];
    regimePath: string[];
    approvalsApproved: number;
    approvalsRejected: number;
    approvalsTimedOut: number;
  };
  /** real news events perceived during a LIVE run (provenance for the prose) */
  newsCitations?: { day: number; headline: string; severity: number; url?: string }[];
  /** AI decision provenance: which trades were AI-proposed, what the critic said */
  aiProvenance?: {
    advisorProposals: { day: number; bucket: string; direction: string; valueCr: number; capped: string }[];
    criticConcerns: { day: number; concern: string }[];
  };
}

function statsLine(x: NonNullable<NarratorInput['naive']>): string {
  return `NAV end ${fmt_inr(x.navEnd)}, max drawdown ${fmt_pct(x.maxDrawdown)}, impact paid ${fmt_inr(x.impactPaid)}, forced-sale legs ${x.forcedSaleEvents}, max participation ${(x.maxParticipation * 100).toFixed(0)}% ADV`;
}

export function templatePostMortem(input: NarratorInput): string {
  const cr = (x: number) => fmt_inr(x);
  const lines: string[] = [];
  lines.push(`## KAVACH post-mortem — ${input.scenario} (${input.days} trading days)`);
  lines.push('');
  lines.push(`**Scenario.** ${input.story}`);
  lines.push('');
  if (input.naive) {
    lines.push(`### NaiveBot (vol-target rebalancer)`);
    lines.push(`- ${statsLine(input.naive)}`);
    lines.push(`- Cumulative margin calls: ${cr(input.naive.marginCumulative)}`);
    lines.push('');
  }
  if (input.governed) {
    lines.push(`### KAVACH-governed agent`);
    lines.push(`- ${statsLine(input.governed)}`);
    lines.push(`- Cumulative margin calls: ${cr(input.governed.marginCumulative)}`);
    lines.push(
      `- Human oversight: ${input.governed.approvalsApproved} approved, ${input.governed.approvalsRejected} rejected, ${input.governed.approvalsTimedOut} timed out (all recorded).`
    );
    lines.push('');
    lines.push(`### Constitution activity`);
    if (input.governed.articleFired.length === 0) {
      lines.push(`- No article breaches — every proposal executed within limits.`);
    } else {
      for (const f of input.governed.articleFired.slice(0, 12)) {
        lines.push(`- Day ${f.day}: ${f.article} — ${f.detail}`);
      }
    }
    lines.push('');
    const regimeSeq = input.governed.regimePath.filter((r, i, a) => i === 0 || r !== a[i - 1]);
    lines.push(`Regime path: ${regimeSeq.join(' → ')}.`);
    lines.push('');
  }
  if (input.newsCitations?.length) {
    lines.push(`### News perceived (real headlines, Gemini radar)`);
    for (const n of input.newsCitations.slice(0, 6)) {
      lines.push(`- Day ${n.day} (severity ${n.severity}): ${n.headline}${n.url ? ` — [source](${n.url})` : ''}`);
    }
    lines.push('');
  }
  if (input.aiProvenance && (input.aiProvenance.advisorProposals.length > 0 || input.aiProvenance.criticConcerns.length > 0)) {
    lines.push(`### AI decision provenance`);
    for (const p of input.aiProvenance.advisorProposals.slice(0, 6)) {
      lines.push(
        `- Day ${p.day}: Advisor proposed ${p.direction === 'buy' ? 'buying' : 'selling'} ₹${p.valueCr.toFixed(1)} Cr ${p.bucket} (${p.capped}).`
      );
    }
    for (const c of input.aiProvenance.criticConcerns.slice(0, 4)) {
      lines.push(`- Day ${c.day}: Critic — ${c.concern}`);
    }
    lines.push('');
  }
  if (input.naive && input.governed) {
    const delta = input.governed.navEnd - input.naive.navEnd;
    lines.push(
      `### Verdict`,
      `Governed bot finished **${delta >= 0 ? '+' : ''}${fmt_inr(delta)}** (${(delta / CRORE).toFixed(0)} Cr) ahead of the naive rebalancer. ` +
        `The naive bot was forced to sell into collapsed ADV (peak participation ${(input.naive.maxParticipation * 100).toFixed(0)}% vs the governed bot's ${(input.governed.maxParticipation * 100).toFixed(0)}%, capped by Article A3). ` +
        `The AI never traded. The constitution never slept. The recorder never forgot.`
    );
  } else if (!input.naive && input.governed) {
    lines.push(
      `### Verdict`,
      `The AI proposed and challenged; the constitution disposed; every choice is in the hash-chained recorder. ` +
        `The AI never traded. The constitution never slept. The recorder never forgot.`
    );
  }
  return lines.join('\n');
}

const NarrationZ = z.object({ markdown: z.string().min(80).max(6000) });

const NARRATION_SCHEMA = {
  type: 'OBJECT',
  properties: { markdown: { type: 'STRING' } },
  required: ['markdown'],
};

/** Gemini post-mortem (server-side, budget-gated, never throws). */
export async function llmPostMortem(input: NarratorInput): Promise<{
  ok: boolean;
  markdown: string;
  latencyMs: number;
  provider: 'gemini' | 'template';
  reason?: string;
}> {
  const t0 = Date.now();
  const facts = templatePostMortem(input); // deterministic facts as ground truth
  const res = await geminiStructured({
    role: 'narrator',
    systemInstruction:
      'You are the KAVACH Narrator. Write a crisp markdown post-mortem for an Indian asset-management ' +
      'risk committee. Use ONLY the facts provided — never invent numbers; you may rephrase but every ' +
      'figure must appear in the supplied digest. Cite the real news headlines and AI-provenance lines ' +
      'when the digest contains them. Structure: ## What happened · ## Where the bots diverged (or ## How ' +
      'the book held, for live runs) · ## Constitution activity · ## Counterfactual · close with: ' +
      '"The AI never traded; the constitution never sleeps; the recorder never forgets." ' +
      'Use ₹ Cr notation (Indian crore). Under 400 words. Output {markdown: string}.',
    prompt: `Flight-recorder digest:\n\n${facts}`,
    zod: NarrationZ,
    responseSchema: NARRATION_SCHEMA,
    timeoutMs: 20_000,
  });
  if (res.ok && res.data) {
    return { ok: true, markdown: res.data.markdown, latencyMs: Date.now() - t0, provider: 'gemini' };
  }
  return {
    ok: false,
    markdown: facts,
    latencyMs: Date.now() - t0,
    provider: 'template',
    reason: res.reason ?? res.outcome,
  };
}
