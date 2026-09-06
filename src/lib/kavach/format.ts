/**
 * KAVACH — Indian money formatting (₹, lakh/crore system).
 * One crore = ₹1,00,00,000 (1e7). One lakh = ₹1,00,000 (1e5).
 * Indian digit grouping: last 3 digits, then groups of 2.
 */

export const CRORE = 1e7;
export const LAKH = 1e5;

/** Indian digit grouping for the integer part: 1e10 → "10,00,00,00,000". */
export function groupIndian(intPart: string): string {
  const n = intPart.length;
  if (n <= 3) return intPart;
  const last3 = intPart.slice(n - 3);
  const rest = intPart.slice(0, n - 3);
  const groups: string[] = [];
  for (let i = rest.length; i > 0; i -= 2) {
    groups.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return `${groups.join(',')},${last3}`;
}

/**
 * fmt_inr_grouped(x): full Indian grouping with 2 decimals.
 * fmt_inr_grouped(1e10) === "₹10,00,00,00,000.00"
 * fmt_inr_grouped(10550000) === "₹1,05,50,000.00"
 */
export function fmt_inr_grouped(x: number, decimals = 2): string {
  if (!isFinite(x)) return '₹—';
  const neg = x < 0;
  const ax = Math.abs(x);
  const fixed = ax.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = groupIndian(intPart);
  const sign = neg ? '-' : '';
  return `${sign}₹${grouped}${decPart ? '.' + decPart : ''}`;
}

/**
 * fmt_inr(x, unit="auto"): institutional scale ₹1,015.25 Cr, retail ₹4.50 L, small ₹1,250.
 * fmt_inr(1.01525e10) === "₹1,015.25 Cr"
 * fmt_inr(450000) === "₹4.50 L"
 * fmt_inr(1250) === "₹1,250"
 */
export function fmt_inr(x: number, unit: 'auto' | 'Cr' | 'L' = 'auto'): string {
  if (!isFinite(x)) return '₹—';
  const neg = x < 0;
  const ax = Math.abs(x);
  const sign = neg ? '-' : '';
  let body: string;
  if (unit === 'Cr' || (unit === 'auto' && ax >= CRORE)) {
    body = `${groupWithDecimals(ax / CRORE)} Cr`;
  } else if (unit === 'L' || (unit === 'auto' && ax >= LAKH)) {
    body = `${groupWithDecimals(ax / LAKH)} L`;
  } else {
    body = groupIndian(ax.toFixed(0));
  }
  return `${sign}₹${body}`;
}

/** "1015.25" → "1,015.25" (Indian grouping on the integer part). */
function groupWithDecimals(v: number): string {
  const fixed = v.toFixed(2);
  const [intPart, dec] = fixed.split('.');
  return `${groupIndian(intPart)}.${dec}`;
}

/** Percentage with fixed decimals, e.g. -6.80% (for tables/charts). */
export function fmt_pct(x: number, decimals = 2): string {
  if (!isFinite(x)) return '—';
  return `${(x * 100).toFixed(decimals)}%`;
}

/** Signed ₹ delta in Cr for headline stats. */
export function fmt_delta_cr(x: number): string {
  const s = x >= 0 ? '+' : '-';
  return `${s}₹${(Math.abs(x) / CRORE).toFixed(0)} Cr`;
}
