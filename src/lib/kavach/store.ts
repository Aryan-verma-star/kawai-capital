/**
 * KAVACH — server-side store (globalThis singleton, HMR-safe).
 * In-memory handles to the running replay + live sessions; durability comes
 * from SQLite (sessions, snapshots, approvals) and the JSONL recorder.
 * LLM health is now Gemini-first (probe = status of the adapter, no spend).
 */

import { ReplayController } from './replay';
import { LiveSession } from './live/liveSession';
import { geminiStatusSync } from './llm/gemini';

interface KavachStore {
  replay: ReplayController | null;
  live: LiveSession | null;
  liveBooting: Promise<LiveSession | null> | null;
}

const g = globalThis as unknown as { __kavach__?: KavachStore };
export const store: KavachStore = g.__kavach__ ?? { replay: null, live: null, liveBooting: null };
g.__kavach__ = store;

/** Get-or-resume the live session (idempotent across concurrent callers). */
export async function getLive(): Promise<LiveSession | null> {
  if (store.live && store.live.status === 'RUNNING') return store.live;
  if (store.liveBooting) return store.liveBooting;
  const p = (async () => {
    const resumed = await LiveSession.resumeLatest();
    if (resumed) {
      store.live = resumed;
      return resumed;
    }
    const created = await LiveSession.create();
    store.live = created;
    return created;
  })();
  store.liveBooting = p;
  try {
    return await p;
  } finally {
    store.liveBooting = null;
  }
}

/** Replace the live session handle (stop → new session). */
export function setLive(s: LiveSession | null): void {
  store.live = s;
}

/**
 * LLM health (Gemini): derived from the adapter's live state — no spend.
 * A cheap real probe happens implicitly on the first radar/advisor call.
 */
export async function checkLlm(): Promise<{
  available: boolean;
  provider: 'gemini' | 'dictionary';
  state: string;
  lastError?: string;
}> {
  const st = geminiStatusSync();
  return {
    available: st.state === 'ok' || st.state === 'fallback',
    provider: st.state === 'nokey' ? 'dictionary' : 'gemini',
    state: st.state,
    lastError: st.breakerReason ?? st.lastOutcome?.reason,
  };
}
