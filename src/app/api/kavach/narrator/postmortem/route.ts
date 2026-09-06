import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

/** GET returns the cached post-mortem (if generated). */
export async function GET() {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  if (!r.complete) {
    return NextResponse.json({ error: 'replay not complete', day: r.day }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    postMortem: r.postMortem,
    generating: r.generatingPostMortem,
  });
}

/** POST generates the post-mortem (LLM with deterministic template fallback). */
export async function POST(req: NextRequest) {
  const r = store.replay;
  if (!r) return NextResponse.json({ error: 'no active replay' }, { status: 404 });
  if (!r.complete) return NextResponse.json({ error: 'replay not complete', day: r.day }, { status: 409 });
  let useLlm = true;
  try {
    const b = (await req.json()) as Record<string, unknown>;
    if (b && b.useLlm === false) useLlm = false;
  } catch {
    /* default llm */
  }
  const pm = await r.generatePostMortem(useLlm);
  return NextResponse.json({ ok: true, postMortem: pm });
}
