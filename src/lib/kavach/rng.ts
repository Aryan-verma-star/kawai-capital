/**
 * KAVACH — deterministic RNG utilities.
 * mulberry32 PRNG + Box-Muller normals + zero-sum (Brownian-bridge) noise field.
 * Noise fields are generated up-front from named streams: agent behaviour can never
 * perturb the draws, so two runs with the same seed are identical.
 */

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(): number {
    return this.next();
  }
  normal(): number {
    // Box-Muller (consumes two uniforms deterministically)
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
}

/** FNV-1a string hash to a 32-bit seed (for named streams). */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function streamRng(name: string, seed: number): Rng {
  return new Rng((hashSeed(name) ^ Math.imul(seed, 2654435761)) >>> 0);
}

/**
 * Zero-sum (Brownian-bridge style) noise increments for one bucket over N days.
 * The cumulative sum is exactly zero, so scripted scenario closes are hit exactly
 * while daily paths carry regime-scaled noise (the "stochastic engine underneath").
 * dailyVols[i] is the per-day noise sigma (return space) for day i+1.
 */
export function zeroSumNoise(rng: Rng, n: number, dailyVols: number[]): number[] {
  const z: number[] = [];
  for (let i = 0; i < n; i++) z.push(rng.normal());
  const mean = z.reduce((a, b) => a + b, 0) / n;
  const out: number[] = [];
  let csum = 0;
  for (let i = 0; i < n; i++) {
    const v = (z[i] - mean) * dailyVols[i];
    out.push(v);
    csum += v;
  }
  // force exact zero drift on the final increment (float hygiene)
  out[n - 1] -= csum;
  return out;
}

/** Correlated daily normals via Cholesky. Matrix must be PSD (jittered if needed). */
export function cholesky(mat: number[][]): number[][] {
  const n = mat.length;
  const A = mat.map((row) => row.slice());
  let jitter = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;
    outer: for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 1e-12) {
            ok = false;
            break outer;
          }
          L[i][j] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    if (ok) return L;
    jitter = jitter === 0 ? 1e-8 : jitter * 10;
    for (let i = 0; i < n; i++) A[i][i] += jitter;
  }
  // identity fallback (never reached with our matrices — tests assert PSD)
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

/** Symmetric matrix eigenvalues via Jacobi rotations (for PSD tests). */
export function eigenvalues(mat: number[][]): number[] {
  const n = mat.length;
  const a = mat.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => a[i][i]);
}
