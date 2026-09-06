import { NextResponse } from 'next/server';
import { CONSTITUTION } from '@/lib/kavach/constants';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    articles: [
      {
        article: 'A1',
        rule: `LIQ ≥ ${(CONSTITUTION.A1_LIQ_FLOOR * 100).toFixed(0)}% of NAV at all times (breachable only by scripted margin/redemption, never by choice)`,
      },
      { article: 'A2', rule: `Max ${(CONSTITUTION.A2_BUCKET_CAP * 100).toFixed(0)}% of gross exposure in any single bucket` },
      { article: 'A3', rule: `Trade size ≤ ${(CONSTITUTION.A3_PARTICIPATION_CAP * 100).toFixed(0)}% of current ADV per bucket per day (fire-sale brake)` },
      {
        article: 'A4',
        rule: `Portfolio 1-day 95% CVaR ≤ ${(CONSTITUTION.A4_CVAR_LIMITS.CALM * 100).toFixed(1)}% NAV (CALM) / ${(CONSTITUTION.A4_CVAR_LIMITS.STRESSED * 100).toFixed(1)}% (STRESSED·RECOVERY) / ${(CONSTITUTION.A4_CVAR_LIMITS.CRISIS * 100).toFixed(1)}% (CRISIS)`,
      },
      { article: 'A5', rule: `Unencumbered LIQ ≥ ${CONSTITUTION.A5_MARGIN_COVER}× projected next-day margin` },
      { article: 'A6', rule: `LIQ ≥ max(5%, 3-day redemption pace)` },
      { article: 'A7', rule: 'LLM outputs may only tighten limits / raise severity / block trades — never loosen' },
      { article: 'A8', rule: 'Human overrides via consent cards with counterfactuals; all overrides recorded' },
      { article: 'A9', rule: 'Radar unavailable in CRISIS → deterministic dictionary (fail-safe, never freeze, never guess)' },
    ],
  });
}
