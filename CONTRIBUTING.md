# Contributing to KAVACH

Thank you for considering a contribution. KAVACH is educational risk-engineering
software; the bar for changes is correctness and honesty, not velocity.

## Ground rules (non-negotiable)

1. **The constitution is the product.** No change may weaken A1–A9, the
   tighten-only semantics of A7, the one-way autonomy ratchet, or the
   hash-chained recorder. If a test fails, fix the code — never the gate.
2. **AI has zero authority.** Any new AI touchpoint goes through
   `src/lib/kavach/llm/gemini.ts` (structured output, budget, audit) and must
   only be able to add constraints.
3. **Determinism in REPLAY is byte-exact.** Two seeded runs must produce
   identical recorder hash chains. If your change touches the replay path,
   run `bun test` — the determinism suite must stay green.
4. **Indian money discipline.** ₹, crore/lakh, Indian digit grouping. No `$`,
   no `M`/`B` suffixes in user-facing strings.
5. **No secrets in code.** Keys are env-only. CI runs with the network
   disabled; all provider tests use fixtures or mocks.

## Workflow

1. Fork, branch (`feat/...` or `fix/...`).
2. `bun install`
3. Make your change. Add or extend tests in `tests/`.
4. `bun run lint && bunx tsc --noEmit && bun test`
5. PR with: what changed, why, test evidence, and — if you touched the world
   engine — the calibration table before/after (`bun scripts/calibrate.ts`).

## Reporting a vulnerability

See SECURITY.md — do not open a public issue for vulnerabilities.
