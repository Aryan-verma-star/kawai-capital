import { NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';
import { abHeadline } from '@/lib/kavach/replay';
import { fmt_inr } from '@/lib/kavach/format';
import { CR } from '@/lib/kavach/constants';

export const dynamic = 'force-dynamic';

/** The combined 1s-poll endpoint for the dashboard. */
export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ active: false }, { status: 200 });
  const state = r.state();
  const headline = abHeadline(state);
  return NextResponse.json({
    active: true,
    ...state,
    abHeadline: headline,
    naivePnl: state.bots['naive'] ? state.bots['naive'].nav - 1000 * CR : null,
    governedPnl: state.bots['governed'] ? state.bots['governed'].nav - 1000 * CR : null,
    naivePnlStr: state.bots['naive'] ? fmt_inr(state.bots['naive'].nav - 1000 * CR) : null,
    governedPnlStr: state.bots['governed'] ? fmt_inr(state.bots['governed'].nav - 1000 * CR) : null,
  });
}
