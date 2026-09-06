# KAVACH — Attributions & Citation Spine

## Methodology papers (implemented formulations)

- **Rockafellar, R.T. & Uryasev, S. (2000)** — *Optimization of Conditional Value-at-Risk*. Journal of Risk. → `src/lib/kavach/metrics/metrics.ts` (`cvar95`: exact fractional tail average over a discrete scenario set — the RU optimum; the same scenarios serve the metric and the optimizer constraint) and `src/lib/kavach/agents/governed.ts` (CVaR term + subgradient in the projected-gradient solver).
- **Almgren, R. & Chriss, N. (2000)** — *Optimal Execution of Portfolio Transactions*. → `src/lib/kavach/world/execution.ts` (temporary cost κ·(V/A)·V paid by the trader; permanent impact γ·(V/A) moving the mid against the trader, decaying 0.90/day).
- **RiskMetrics (J.P. Morgan, 1996)** — EWMA volatility with λ = 0.94. → `metrics.ts` (`updateDay`).
- **Grossman, S. & Zhou, Z. (1993)** — *Optimal Investment Strategies with Controlling Drawdown*. → cited; drawdown series + recovery awareness implemented; full G&Z optimal control is a declared stretch goal, **not** implemented.
- **Brunnermeier, M. & Pedersen, L.H. (2009)** — *Market Liquidity and Funding Liquidity*. Review of Financial Studies. → world design: the ADV liquidity mirage, margin spirals, and the two funding channels.
- **Wachter, S. et al. (2017)** — *Counterfactual Explanations without Opening the Black Box*. Harvard JL&T. → consent-card counterfactuals ("if rejected: projected CVaR path, liquidity horizon, forced-sale risk").

## Design-influence citations

- **ECB Financial Stability Review (2020)** — vol-targeting procyclicality: the NaiveBot's failure mode is this paper, deliberately.
- **Sushko, V. (BIS Quarterly Review, 2018)** — mechanical rebalancing and the XIV blowup: the NaiveBot's rebalance channel.
- **Bainbridge, S. (1983)** — *Ironies of Automation*: the human-oversight thesis behind the autonomy dial and consent architecture.
- **EU AI Act, Article 14 (human oversight)** — consent-card patterns: one-way ratchet, counterfactuals, recorded decisions.
- **Basel FRTB / RBI FRTB directions** — the VaR→Expected Shortfall shift (why A4 limits CVaR, not VaR) and FRTB liquidity horizons (days-to-liquidate at participation-rate × current ADV).

## Indian historical anchors

- **2013 Taper Tantrum** — USD/INR ~55→68; 10Y G-Sec yield ~7.1%→9.2%; gold rallied in INR. (Sim uses the spec's stylized FX 88→96.4→94; the close targets are calibrated to −6.8% GSEC / −6.0% EQ / +9.5% GOLD.)
- **IL&FS default, Sept 2018** — ₹91,000 Cr group debt; NBFC CP market freeze; debt-fund redemption waves. → ILFS-18 script.
- **Franklin Templeton, April 2020** — six schemes, ~₹30,000 Cr frozen: the liquidity mirage made flesh; the redemption-tap design.
- **RBI, March 2020** — repo cut 115bp + LTRO/OMO: the day-14 COVID intervention event.
- **SEBI stress-testing norms for mutual funds (2024) and peak-margin rules (2021)** — the constitution's regulatory accent.

## Open-source reuse (libraries, hackathon policy: allowed with citation)

- **numpy-style linear algebra**: implemented in TypeScript (`src/lib/kavach/rng.ts`: mulberry32 PRNG, Box-Muller, Cholesky with PSD jitter, Jacobi eigenvalues) — no numpy dependency in this environment.
- **Next.js 16 / React 19 / Tailwind CSS 4 / shadcn-UI / Radix** — application framework and UI components (`src/app`, `src/components/ui`).
- **Recharts** — A/B NAV and drawdown charts.
- **z-ai-web-dev-sdk** — server-side LLM access for the Event Radar and the Narrator (replaces the OpenAI-compatible endpoint of the original spec; same contracts: JSON mode, timeout, deterministic fallback).
- **Bun test** — the §12 test matrix (`tests/kavach.test.ts`).

## Domain glue written for this project (not reused)

Ledger & settlement semantics (cash sign conventions, LIQ sweep), MTF maintenance mechanics with lender enforcement, CCIL-flavoured haircut margin, redemption taps, zero-sum (Brownian-bridge) noise around scripted anchors, the regime machine with hysteresis, the constitution A1–A9 and its one-way-valve blocking semantics, consent cards with counterfactuals, the autonomy ratchet, and the hash-chained flight recorder (SHA-256 over canonical JSON via node:crypto).
