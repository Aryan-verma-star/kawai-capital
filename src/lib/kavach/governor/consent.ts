/**
 * KAVACH — autonomy dial + consent architecture (M4.3).
 *
 * Autonomy dial: FULL (auto within constitution) → SUPERVISED (trades above
 * threshold or any CRISIS-regime trade need approval) → CONSERVATIVE (all
 * approvals). ONE-WAY RATCHET: while regime is CRISIS the dial may only move
 * toward more scrutiny — it never loosens mid-crisis (EU AI Act Art. 14
 * human-oversight pattern).
 *
 * Approval cards carry a counterfactual (Wachter et al. 2017):
 * "if rejected: projected CVaR path, liquidity horizon, forced-sale risk".
 * Approved / rejected / timeout are all recorded with the human's id
 * (demo: "Treasury Head"). Timeout ⇒ trade not executed (never auto-approve).
 */

import { ApprovalCard, AutonomyLevel, Regime } from '../types';
import { CONSTITUTION } from '../constants';

const ORDER = { FULL: 0, SUPERVISED: 1, CONSERVATIVE: 2 } as const;

export class AutonomyDial {
  level: AutonomyLevel;
  private ratchetArmed = false;
  ratchetEvents: { day: number; from: string; to: string; blocked: boolean }[] = [];

  constructor(start: 'FULL' | 'SUPERVISED' | 'CONSERVATIVE' = 'SUPERVISED') {
    this.level = start;
  }

  /** Durable snapshot (LIVE sessions survive restarts). */
  serialize(): { level: AutonomyLevel; ratchetArmed: boolean; ratchetEvents: AutonomyDial['ratchetEvents'] } {
    return { level: this.level, ratchetArmed: this.ratchetArmed, ratchetEvents: this.ratchetEvents };
  }

  restore(s: ReturnType<AutonomyDial['serialize']>): void {
    this.level = s.level;
    this.ratchetArmed = s.ratchetArmed;
    this.ratchetEvents = s.ratchetEvents;
  }

  armRatchet(): void {
    this.ratchetArmed = true;
  }

  disarmRatchet(): void {
    this.ratchetArmed = false;
  }

  isRatchetArmed(): boolean {
    return this.ratchetArmed;
  }

  /** Returns true if the change was applied. */
  setLevel(next: AutonomyLevel, day: number): boolean {
    if (this.ratchetArmed && ORDER[next] < ORDER[this.level]) {
      this.ratchetEvents.push({ day, from: this.level, to: next, blocked: true });
      return false; // one-way ratchet: blocked
    }
    if (next === this.level) return true;
    this.ratchetEvents.push({ day, from: this.level, to: next, blocked: false });
    this.level = next;
    return true;
  }
}

export class ConsentQueue {
  private cards: ApprovalCard[] = [];
  private nextId = 1;

  /** Durable snapshot — the pending queue survives restarts by design. */
  serialize(): { cards: ApprovalCard[]; nextId: number } {
    return { cards: this.cards, nextId: this.nextId };
  }

  restore(s: ReturnType<ConsentQueue['serialize']>): void {
    this.cards = s.cards;
    this.nextId = s.nextId;
  }

  pending(): ApprovalCard[] {
    return this.cards.filter((c) => c.status === 'PENDING');
  }

  recent(limit = 20): ApprovalCard[] {
    return this.cards.slice(-limit);
  }

  all(): ApprovalCard[] {
    return this.cards;
  }

  create(
    day: number,
    trade: ApprovalCard['trade'],
    regime: ApprovalCard['regime'],
    articlesInvoked: string[],
    counterfactual: ApprovalCard['counterfactual']
  ): ApprovalCard {
    const card: ApprovalCard = {
      id: `APR-${String(this.nextId++).padStart(4, '0')}`,
      day,
      createdAtDay: day,
      deadlineDay: day + CONSTITUTION.APPROVAL_DEADLINE_DAYS,
      trade,
      regime,
      articlesInvoked,
      counterfactual,
      status: 'PENDING',
    };
    this.cards.push(card);
    return card;
  }

  decide(id: string, decision: 'APPROVED' | 'REJECTED', by = 'Treasury Head'): ApprovalCard | null {
    const card = this.cards.find((c) => c.id === id && c.status === 'PENDING');
    if (!card) return null;
    card.status = decision;
    card.decidedBy = by;
    return card;
  }

  /** Expire cards past their deadline; returns the expired ones. */
  expirePast(day: number): ApprovalCard[] {
    const expired: ApprovalCard[] = [];
    for (const c of this.cards) {
      if (c.status === 'PENDING' && day > c.deadlineDay) {
        c.status = 'TIMEOUT';
        c.decidedBy = 'system:timeout';
        expired.push(c);
      }
    }
    return expired;
  }

  /** Does this trade need human approval under the current autonomy level? */
  needsApproval(level: AutonomyLevel, tradeValue: number, nav: number, regime: Regime): boolean {
    if (level === 'CONSERVATIVE') return true;
    if (level === 'FULL') return false;
    return tradeValue > CONSTITUTION.APPROVAL_THRESHOLD_NAV * nav || regime === 'CRISIS';
  }
}
