import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';
import { AutonomyLevel } from '@/lib/kavach/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const level = String(b.autonomy ?? '').toUpperCase();
  if (!['FULL', 'SUPERVISED', 'CONSERVATIVE'].includes(level)) {
    return NextResponse.json({ error: 'autonomy must be FULL | SUPERVISED | CONSERVATIVE' }, { status: 400 });
  }
  const applied = r.setAutonomy(level as AutonomyLevel);
  const g = r.governed?.governed;
  return NextResponse.json({
    ok: applied,
    autonomy: g?.autonomy.level,
    ratchetArmed: g?.autonomy.isRatchetArmed() ?? false,
    note: applied
      ? `autonomy set to ${level}`
      : `one-way ratchet active (CRISis regime): may only move toward more scrutiny`,
  });
}
