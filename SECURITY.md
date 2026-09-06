# Security Policy

## Reporting a vulnerability

Report privately to the maintainers (open a GitHub Security Advisory on the
repository, or contact a maintainer directly). Please do not open a public
issue for anything security-relevant. We aim to respond within 72 hours.

## Key handling

- API keys (Gemini, GNews, Marketaux, Finnhub, Turso) are **environment
  variables only** — never committed, never logged, never sent to the client.
- `.env*` is gitignored; `.env.example` documents every variable without values.
- A test greps the client entry points for key names
  (`tests/kavach-phase2.test.ts` → "Client-bundle hygiene").

## Attack surface notes

- **Prompt injection via news headlines is a considered threat**: headlines are
  HTML-escaped before reaching the model; system prompts instruct the model to
  treat them as untrusted data; the A7 gate structurally rejects any output
  that attempts to loosen limits (see `a7Apply` in `src/lib/kavach/llm/radar.ts`).
- **The AI layer cannot trade.** Every proposal passes the same constitution
  evaluation as deterministic trades; the Critic can only raise approval
  thresholds.
- **The flight recorder is tamper-evident** (SHA-256 prev→entry chain) but not
  tamper-proof against someone with filesystem access — treat `data/` as
  operator-trusted storage.
- Rate limiting is in-memory per-instance (60 req/min/IP on AI endpoints);
  deploy behind a proxy for production hardening.

## Scope

KAVACH is educational software. It never places real orders and is not
investment advice.
