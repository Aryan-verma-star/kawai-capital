/**
 * KAVACH — NSE market-hours awareness (LIVE PAPER).
 * Mon–Fri 09:15–15:30 IST. Holiday list is a hardcoded approximation
 * (documented in README as approximate; NSE's official circular governs).
 * Outside hours LIVE shows "MARKET CLOSED — prices as of last close" and
 * no rebalance fires.
 */

export type MarketSession = 'PRE_OPEN' | 'OPEN' | 'LUNCH' | 'CLOSING' | 'CLOSED' | 'WEEKEND' | 'HOLIDAY';

export interface MarketStatus {
  open: boolean;
  session: MarketSession;
  istDate: string; // YYYY-MM-DD
  istTime: string; // HH:MM
  reason: string;
}

/** Approximate NSE trading holidays (2025–2026). Best-effort, documented. */
export const NSE_HOLIDAYS: Record<string, string> = {
  '2025-01-26': 'Republic Day',
  '2025-02-26': 'Mahashivratri',
  '2025-03-14': 'Holi',
  '2025-03-31': 'Id-Ul-Fitr',
  '2025-04-10': 'Mahavir Jayanti',
  '2025-04-14': 'Dr. Ambedkar Jayanti',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Maharashtra Day',
  '2025-08-15': 'Independence Day',
  '2025-08-27': 'Ganesh Chaturthi',
  '2025-10-02': 'Gandhi Jayanti / Dussehra eve',
  '2025-10-21': 'Dussehra',
  '2025-11-05': 'Diwali (special session: Muhurat trading only)',
  '2025-11-14': 'Guru Nanak Jayanti',
  '2026-01-26': 'Republic Day',
  '2026-02-15': 'Mahashivratri',
  '2026-03-04': 'Holi',
  '2026-03-21': 'Id-Ul-Fitr',
  '2026-04-01': 'Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-08-15': 'Independence Day',
  '2026-09-25': 'Ganesh Chaturthi',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-09': 'Diwali',
  '2026-11-24': 'Guru Nanak Jayanti',
};

/** IST "now" as { y, m, d, hh, mm, dow } — pure, testable against any Date. */
export function istParts(now: Date = new Date()): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  dow: number;
} {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
    hh: ist.getUTCHours(),
    mm: ist.getUTCMinutes(),
    dow: ist.getUTCDay(),
  };
}

export function istDateStringOf(now: Date = new Date()): string {
  const p = istParts(now);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Market status at a given instant. 09:15–15:30 IST weekdays minus holidays. */
export function marketStatus(now: Date = new Date()): MarketStatus {
  const p = istParts(now);
  const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const time = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  const mins = p.hh * 60 + p.mm;
  const holiday = NSE_HOLIDAYS[date];
  if (p.dow === 0 || p.dow === 6) {
    return { open: false, session: 'WEEKEND', istDate: date, istTime: time, reason: 'weekend — NSE closed' };
  }
  if (holiday) {
    return { open: false, session: 'HOLIDAY', istDate: date, istTime: time, reason: `${holiday} — NSE holiday (approximate list)` };
  }
  if (mins < 9 * 60 + 15) {
    return { open: false, session: 'PRE_OPEN', istDate: date, istTime: time, reason: 'pre-open (before 09:15 IST)' };
  }
  if (mins > 15 * 60 + 30) {
    return { open: false, session: 'CLOSED', istDate: date, istTime: time, reason: 'market closed (after 15:30 IST)' };
  }
  const session: MarketSession = mins < 12 * 60 ? 'OPEN' : mins < 13 * 60 ? 'LUNCH' : 'CLOSING';
  return { open: true, session, istDate: date, istTime: time, reason: 'NSE cash session' };
}
