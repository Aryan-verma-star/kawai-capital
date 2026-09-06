import { NextRequest, NextResponse } from 'next/server';
import { getLive } from '@/lib/kavach/store';
import { rateLimit } from '@/lib/kavach/apiHardening';

export const dynamic = 'force-dynamic';

/** GET /api/kavach/live/postmortem — cached live post-mortem (if generated). */
export async function GET() {
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  return NextResponse.json({ ok: true, postMortem: s.postMortemCache, day: s.day });
}

/** POST /api/kavach/live/postmortem — generate (Gemini, template fallback). */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req);
  if (limited) return limited;
  const s = await getLive();
  if (!s) return NextResponse.json({ error: 'no live session' }, { status: 404 });
  let useLlm = true;
  try {
    const b = (await req.json()) as Record<string, unknown>;
    if (b && b.useLlm === false) useLlm = false;
  } catch {
    /* default gemini */
  }
  const pm = await s.generatePostMortem(useLlm);
  return NextResponse.json({ ok: true, postMortem: pm });
}
