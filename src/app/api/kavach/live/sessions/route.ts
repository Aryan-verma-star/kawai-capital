import { NextResponse } from 'next/server';
import { getLive } from '@/lib/kavach/store';

export const dynamic = 'force-dynamic';

/** Session history (LIVE): the durable sessions in SQLite — proof that paper
 *  books survive restarts. Read-only; the current session is flagged and
 *  always present (even when newer stopped sessions push it off page one). */
export async function GET() {
  try {
    const { db } = await import('@/lib/db');
    const current = await getLive();
    const rows = await db.kavachSession.findMany({
      where: { kind: 'live' },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true,
        day: true,
        navCr: true,
        status: true,
        headHash: true,
        scenario: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // the current session must always be listed (test harnesses can create
    // many newer stopped sessions that would otherwise push it off page one)
    let list = rows;
    if (current && !rows.some((r) => r.id === current.id)) {
      const cur = await db.kavachSession.findUnique({ where: { id: current.id } });
      if (cur) list = [cur, ...rows.slice(0, 11)];
    }
    return NextResponse.json({
      sessions: list.map((r) => ({
        id: r.id,
        day: r.day,
        navCr: r.navCr,
        status: r.status,
        headHash: r.headHash ? r.headHash.slice(0, 12) : null,
        current: current ? r.id === current.id : false,
        openedAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
