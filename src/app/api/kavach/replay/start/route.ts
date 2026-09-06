import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';
import { ReplayController } from '@/lib/kavach/replay';
import { AutonomyLevel, ScenarioId } from '@/lib/kavach/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const scenario = String(b.scenario ?? 'COVID-20') as ScenarioId;
  const modeRaw = String(b.mode ?? 'both');
  const mode = (['naive', 'governed', 'both'].includes(modeRaw) ? modeRaw : 'both') as
    | 'naive'
    | 'governed'
    | 'both';
  const autonomy = (['FULL', 'SUPERVISED', 'CONSERVATIVE'].includes(String(b.autonomy ?? ''))
    ? String(b.autonomy)
    : 'FULL') as AutonomyLevel;
  const seed = Number.isFinite(Number(b.seed)) ? Number(b.seed) : 42;
  const llmRadar = Boolean(b.llmRadar);

  const replay = new ReplayController({ scenario, mode, seed, autonomy, llmRadar });
  store.replay = replay;
  return NextResponse.json({
    ok: true,
    scenario,
    mode,
    seed,
    autonomy,
    llmRadar,
    days: replay.state().scenario.days,
  });
}

export async function DELETE() {
  store.replay = null;
  return NextResponse.json({ ok: true });
}
