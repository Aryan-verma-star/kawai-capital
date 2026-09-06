/**
 * KAVACH — flight recorder (M4).
 * Append-only JSONL, hash-chained (prev_hash → entry_hash over canonical JSON).
 * Every observation, regime transition, proposal, constitution evaluation,
 * approval, override, execution, impact cost and margin event lands here.
 *
 * The hash covers the canonical (deterministic) payload only; wall-clock time
 * and LLM provider metadata ride in unhashed `meta` so two seeded runs produce
 * identical hash chains (the §5.5 determinism gate) while remaining a real
 * audit trail. SEBI-flavoured audit-trail framing in the README.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RecorderEntry } from '../types';

const GENESIS = '0'.repeat(64);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // rotate at 5 MB
const KEEP_FILES = 10; // keep the 10 newest recorder files

function canonicalize(obj: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'number') {
      if (!isFinite(v)) return 'NaN';
      const r = Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e10) / 1e10;
      return Object.is(r, -0) ? 0 : r;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = norm((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(obj));
}

export function hashEntry(prev: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(prev).update('|').update(canonicalize(payload)).digest('hex');
}

export class FlightRecorder {
  private entries: RecorderEntry[] = [];
  private prevHash = GENESIS;
  /** chain anchor this recorder starts from (GENESIS, or the resumed head) */
  private startHash = GENESIS;
  private seq = 0;
  private filePath: string | null = null;
  private rotation = 0;
  fileError: string | null = null;

  constructor(
    runId: string,
    persist = true,
    /** resume a chain across restarts: continue seq + prevHash (LIVE) */
    resume?: { prevHash: string; seq: number }
  ) {
    if (resume) {
      this.prevHash = resume.prevHash || GENESIS;
      this.startHash = this.prevHash;
      this.seq = resume.seq;
    }
    if (persist) {
      try {
        const dir = path.join(process.cwd(), 'data', 'flightrecorder');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        pruneRecorderDir(dir);
        this.filePath = path.join(dir, `${runId}.jsonl`);
        fs.writeFileSync(this.filePath, '');
      } catch (e) {
        this.fileError = e instanceof Error ? e.message : String(e);
        this.filePath = null;
      }
    }
  }

  record(day: number, kind: string, payload: Record<string, unknown>, meta?: RecorderEntry['meta']): RecorderEntry {
    const entry: RecorderEntry = {
      seq: this.seq++,
      day,
      kind,
      payload,
      prevHash: this.prevHash,
      entryHash: '',
      meta: { ts: Date.now(), ...(meta ?? {}) },
    };
    entry.entryHash = hashEntry(entry.prevHash, { day, kind, ...payload });
    this.prevHash = entry.entryHash;
    this.entries.push(entry);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
        this.rotateIfNeeded();
      } catch {
        this.filePath = null;
      }
    }
    return entry;
  }

  /** Size-based rotation: 5 MB per file; the directory keeps the 10 newest. */
  private rotateIfNeeded(): void {
    if (!this.filePath) return;
    try {
      const st = fs.statSync(this.filePath);
      if (st.size < MAX_FILE_BYTES) return;
      this.rotation += 1;
      const rotated = this.filePath.replace(/\.jsonl$/, `-r${this.rotation}.jsonl`);
      fs.renameSync(this.filePath, rotated);
      fs.writeFileSync(this.filePath, '');
      const dir = path.dirname(this.filePath);
      pruneRecorderDir(dir);
    } catch {
      // rotation failure is non-fatal: keep appending to the current file
    }
  }

  all(): RecorderEntry[] {
    return this.entries;
  }

  range(from: number, to: number): RecorderEntry[] {
    return this.entries.filter((e) => e.day >= from && e.day <= to);
  }

  headHash(): string {
    return this.prevHash;
  }

  /** Chain anchor (GENESIS for fresh runs; the resumed head for LIVE resumes). */
  anchorHash(): string {
    return this.startHash;
  }

  /** Verify this recorder's segment (walks from the anchor; a resumed
   *  recorder's first entry links to the previous file's head by construction). */
  verify(): boolean {
    let prev = this.startHash;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      if (e.entryHash !== hashEntry(prev, { day: e.day, kind: e.kind, ...e.payload })) return false;
      prev = e.entryHash;
    }
    return true;
  }

  size(): number {
    return this.entries.length;
  }
}

/** Keep only the newest KEEP_FILES recorder files (5 MB × 10 discipline). */
function pruneRecorderDir(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(KEEP_FILES)) {
      try {
        fs.unlinkSync(path.join(dir, old.f));
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}
