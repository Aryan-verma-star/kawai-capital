# KAVACH — Worklog (Event-Aware Capital Governor for Indian Markets)

Project: INIT 2026 Hackathon · FinTech / Asset & Capital Management Track
One-line: an optimizer that can propose anything, a constitution that permits only what survives
a stress test, a flight recorder that proves it, and a crisis-replay demo where the naive bot dies
and the governed bot doesn't.

## Environment adaptation (IMPORTANT — read before continuing)
The master spec targets Python/FastAPI + React/Vite. This sandbox is a **Next.js 16 +
TypeScript** environment with a single user-visible route (`/`) and API routes as the only
backend surface. Therefore:
- The entire KAVACH core (world engine, metrics, optimizer, governor, recorder, LLM layer)
  is implemented in **TypeScript under `src/lib/kavach/`**.
- FastAPI endpoints become **Next.js API routes under `src/app/api/kavach/**`** (same paths,
  same JSON contracts).
- The React/Vite dashboard becomes the single Next.js page (`src/app/page.tsx`).
- `z-ai-web-dev-sdk` replaces the OpenAI SDK (server-side only) for Radar + Narrator.
- Tests use `bun test` (pytest-equivalent matrix; see §12 of spec).
- All invariants, contracts, calibration targets (§5.4) and the honesty protocol unchanged.

## Determinism architecture (key decision)
- Per-scenario noise fields are **pre-generated from seed** (Brownian-bridge, zero-sum per
  bucket → scenario closes hit scripted targets exactly). Noise is agent-independent.
- Each bot session has its own market impact dislocation state; everything else is shared.
- Flight recorder hash chain covers canonical (deterministic) payload content; wall-clock /
  provider / latency live in unhashed `meta` fields (audit trail without breaking determinism).
- LLM radar is opt-in ("live" mode); default replay uses the deterministic dictionary so
  two seeded runs produce identical hash chains (the §5.5 determinism gate). Narrator
  (post-mortem) is post-hoc prose and never part of the hash chain.

---
Task ID: M0
Agent: main (Z.ai Code)
Task: Scaffold KAVACH repo structure, types, constants, RNG, Indian money formatting.

Work Log:
- Inspected environment: Next.js 16.1.3, Tailwind 4, full shadcn/ui set, recharts, z-ai-web-dev-sdk present. Dev server already running on :3000.
- Loaded LLM skill (z-ai-web-dev-sdk usage pattern) for M5 radar/narrator.
- Created this worklog.
- Planned full file tree under src/lib/kavach/{world,metrics,agents,governor,recorder,llm}.

Stage Summary:
- Environment adaptation documented; core architecture decided (see above).
- Next: M1 world engine — book, PRNG, scenarios, margin channels, Almgren-Chriss impact, ledger.

---
Task ID: M1+M2+M3+M4-core
Agent: main (Z.ai Code)
Task: World engine, metrics, two agents, governor core — built and calibrated to §5.4.

Work Log:
- Built src/lib/kavach/: types, rng (mulberry32 + Brownian-bridge zero-sum noise), format (Indian ₹), constants (book, vols, PSD corr matrices, impact, constitution).
- world/scenarios.ts: three Indian crisis scripts with anchor paths, phase/ADV paths, margin scripts (MTF ratio hikes + CCIL haircut hikes), redemption taps, headlines.
- world/engine.ts: day cycle (open → margin/redemption → agent → close), Almgren-Chriss impact with decaying permanent dislocation, MTF lender enforcement, LIQ sweep, ledger identity.
- metrics/metrics.ts: EWMA λ=0.94, RU CVaR (exact fractional tail average on discrete scenarios), drawdown, FRTB liquidity horizon, COVID stress-gate shadow replay, 250-day calm warm-up.
- agents/naive.ts: vol-target rebalancer (full scale, 0.5 gap speed, pro-rata forced sales, knife-catching rebalance) — the villain.
- agents/governed.ts: projected-gradient mean-risk optimizer over discrete CVaR scenarios, regime-aware gross caps, LIQ floor (A1/A5/A6), A3-clipped intents, constitution gate, consent cards w/ counterfactuals, LIQ-first then MTF repayment.
- governor/: regime machine (hysteresis 2-in/3-out, decaying-max radar pressure), constitution A1–A9 (A2 on GROSS, A4 blocks deterioration only — one-way valve on risk), autonomy ratchet, consent queue.
- recorder/flight.ts: SHA-256 hash-chained JSONL (canonical payloads hashed; wall-clock/provider in unhashed meta).
- llm/radar.ts + narrator.ts: dictionary radar, LLM radar (z-ai-web-dev-sdk, 10s timeout, 6-layer defense), post-mortem with template fallback.

Defects found & fixed (the ledger-truth discipline in action):
1. scriptedDailyRets returned interpolated CUMULATIVE returns as daily returns → paths compounded 2–4×. Fixed with cumAt(d)/cumAt(d−1).
2. Day-0 CCIL posting never debited cash → NAV ₹1,011.25 Cr. Fixed.
3. mat() symmetrizer read undefined upper-triangle entries → NaN in ALL correlation matrices → NaN warm-up → NaN vols → NaN trades. Fixed with explicit lower-triangular fill.
4. execute() debited cash on SELLS (sign error) + repayBorrowing accepted negative amounts → borrowings exploded → MTF death spiral. Fixed both.
5. Governed forced-sale breach logic fired per-bucket instead of last-resort → uncapped selling. Fixed to two-pass capped waterfall.
6. A2 measured bucket/NAV (day-0 EQ=50% → governor paralyzed). Now bucket/GROSS (day-0 = 40.36%, at cap). A4 now blocks deterioration, not remediation.
7. Governed MTF repayment starved the LIQ buffer → 3 missed ILFS redemptions. Now LIQ floor built first, repayment from surplus. Default autonomy FULL (hero survives unattended; approval inbox is the interactive layer).

Calibration (world mode, seed 42) — 29/29 gates:
- Day-0 NAV ₹1,000.00 Cr exact; ledger residual ≤ 3.8e-6 abs (≤ ₹100 gate) all days, all scenarios.
- TANTRUM: GSEC −6.80 / EQ −6.17 / GOLD +9.36 (targets ±1.5) ✓; margin ₹4.90 Cr (≈4.5) ✓; GSEC maxDD −7.62% ✓.
- ILFS: CRED −15.19 / IGCORP −5.07 / GSEC +1.97 ✓; margin ₹2.19 Cr ✓.
- COVID: EQ −8.53 / GOLD +8.17 / GSEC +1.99 ✓; margin ₹14.49 Cr (15.2±0.75) ✓; peak call ₹1.79 Cr ✓.
- All DD caps hold (GSEC −10 / IGCORP −12 / CRED −25 / EQ −35).

A/B replay (seed 42):
- TANTRUM: naive 945.02 vs governed 946.36 (+₹1.3 Cr — 2013 was survivable; authentic).
- ILFS-18: naive 742.22 (−25.8%, 13 cascade days, 279% peak participation, ₹37 Cr impact) vs governed 799.57 (−20.0%, capped 10%, 6 recorded forced legs, 0 missed redemptions).
- COVID-20: naive 890.61 (−10.9%, 10 cascade days, 140% participation) vs governed 957.17 (−4.3%, capped 10%, zero forced sales).

Stage Summary:
- M1 invariants hold; calibration table green; the demo story is real, not narrated.
- Next: M6a API routes, M6b UI, M5 LLM wiring, M7 tests/docs.

---
Task ID: M6+M7 (API, UI, LLM wiring, tests, docs)
Agent: main (Z.ai Code)
Task: API routes, replay console UI, LLM radar/narrator wiring, 89-test matrix, README/ATTRIBUTIONS.

Work Log:
- API (src/app/api/kavach/**): health (LLM probe + chain validity), replay start/step/stop, combined /state (1s poll), portfolio, metrics, governor status/constitution, approve/[id], mode (ratchet-enforced), radar, regime, approvals/pending, flightrecorder (range query), narrator/postmortem (GET cached / POST generate).
- store.ts: globalThis singleton (HMR-safe) + 60s-cached LLM health check.
- UI (src/app/page.tsx, single route): Bloomberg-terminal dark console — header (regime badge, autonomy dial, day counter, ₹ NAV chips in Indian format, LLM dot), scenario picker with 3 Indian crisis stories + transport controls (run/play/pause/step/skip/speed), A/B ComposedChart (naive vs governed NAV) + drawdown Area strip, book table (values/weights/vol/liq-days + margin/impact/participation stats), right rail (radar feed with provider badges + A7 markers, approval inbox with counterfactual cards + recent decisions, constitution panel live + rules view), flight-recorder timeline scrubber + color-coded entries, post-mortem Sheet with react-markdown, sticky footer with the pitch line.
- LLM wired via z-ai-web-dev-sdk (server-only): narrator post-mortem verified live (provider "llm", ~3s); radar opt-in toggle; dictionary default for determinism.
- Bench-tested through agent-browser: page render, restart, step, autoplay (1 day/sec), scenario switch (ILFS 45d), SUPERVISED consent cards, approve flow (APR-0022 → EXECUTION recorded, chain valid), timeout flow, post-mortem drawer, mobile 390×844 responsive, no console errors.
- Defect found by browser test & fixed: human-approved trades executed at stale A3 clips (ADV halved between proposal and approval → 20% ADV breach). Now re-clipped at execution time, recorded as re_clipped_to_a3.
- Defect found by tests & fixed: margin events didn't attribute LIQ-funded payments (paidFromLiq) — the paid-or-liquidated invariant is now explicit.
- Regime machine: volRatio now computed on a FIXED day-0-weight benchmark (governor perceives the market, not its own de-risked book) — CRISis badge correctly fires in COVID (day ~18); restructured state machine (sequential CALM→STRESSED→CRISis with 2-day confirm).
- Format: negative sign before ₹ ("-₹2,460.00 Cr"); Cr/L values carry Indian grouping ("₹1,015.25 Cr").
- Tests: tests/kavach.test.ts — 89 tests, 971 assertions, 0 failures (bun test). Suites: Ledger 12, Calibration 19, Determinism 2, Impact & liquidity 9, Governor 13, LLM guardrails 8, Metrics 6, ReplayController+live API 10, Formatting 5, Flight recorder 3.
- README.md (thesis, architecture, scenario stories, calibration table with actuals, constitution, LLM policy, honest limitations) + ATTRIBUTIONS.md (citation spine + reuse policy).
- Calibration re-verified post-changes: 29/29 world gates; A/B (seed 42): TANTRUM +₹11.5 Cr, ILFS +₹58.2 Cr, COVID +₹77.3 Cr; governed capped at 10.0% ADV everywhere, 0 missed redemptions.

Stage Summary:
- Full KAVACH system delivered and browser-verified: world engine calibrated, governor enforced, recorder hash-chained and persisted (data/flightrecorder/*.jsonl), LLM used for perception+prose with deterministic fallback, UI interactive at /.
- Remaining: 15-min webDevReview cron (mandatory), final honesty report.

---
Task ID: FINAL
Agent: main (Z.ai Code)
Task: Post-launch self-verification + cron + honesty report.

Work Log:
- agent-browser final pass: page renders, replay interactive, autoplay verified (1 day/sec), mobile 390×844 layout holds, sticky footer present, zero console errors.
- bun run lint: clean. dev.log: all 200s post-fix (stale ⨯ entries are historical).
- 15-minute webDevReview cron created (job_id 362369) with the mandatory QA + continuation prompt.
- Final state: 89/89 tests green, 29/29 world-mode calibration gates green, hash chains verified on both bots, flight recorder persisted to data/flightrecorder/ (56 runs).

Stage Summary:
- KAVACH delivered end-to-end. Open the Preview Panel (or "Open in New Tab") → pick a crisis → RUN A/B REPLAY.

---
Task ID: P2-1 (R1-pre + R2 + R3 foundation)
Agent: main (Z.ai Code)
Task: Phase 2 kickoff — remove sandbox SDK, install @google/genai + fast-xml-parser, Prisma v2 schema, Gemini adapter, news layer, decision-loop AI roles.

Work Log:
- Removed z-ai-web-dev-sdk from package.json; added @google/genai + fast-xml-parser. grep -ri "z-ai" src/ now clean.
- Prisma schema v2: KavachSession, Article, RadarEventRow, ApprovalRow (durable pending queue), AiCall (budget + audit), BookSnapshot (unique sessionId+day). db:push OK (db/custom.db).
- src/lib/kavach/llm/gemini.ts: one adapter for ALL AI calls — structured output (responseMimeType JSON + native responseSchema), zod post-parse, ≤8 RPM limiter, 10s timeout, exactly 1 retry on 429/5xx w/ 2s backoff, 2-strike circuit breaker (10 min open), MAX_AI_CALLS_PER_DAY budget (default 150, counted per IST day in DB), every call audited (role/model/promptHash/latency/tokens/outcome). Test seam __setGeminiGenerateForTests. providerBadge: GEMINI | DICT | AI BUDGET SPENT.
- radar.ts rewritten: dictionary untouched (REPLAY determinism); llmRadar → geminiStructured (single headline); NEW geminiRadarBatch (≤20 headlines/call, LIVE); NEW a7Apply() — the tighten-only gate; loosen-attempt regex → REJECTED_BY_A7; prompt-injection hygiene (HTML-escape, untrusted-data instruction).
- narrator.ts → Gemini, now includes news citations + AI provenance sections; template fallback unchanged.
- NEW llm/advisor.ts: ≤3 ranked proposals, constitution pre-clip (A3 10% ADV / 10% NAV / held cap) BEFORE viability; clipAdvisorProposal exported for tests.
- NEW llm/critic.ts: verdict approve|flag|block_suggestion + concerns; criticEffect() → escalation (flag → bucket consent card even in FULL; block_suggestion → whole list). Only ADDS constraints.
- news/: types (Article, NewsProvider, TOPIC_QUERIES), googleNews.ts (RSS parse, fast-xml-parser, India edition hl/gl/ceid, source-suffix extraction), gdelt.ts (DOC 2.0 artlist + tone), keyed.ts (GNews/Marketaux/Finnhub env-gated), dedupe.ts (URL canonicalization + sha256 key, trigram Jaccard ≥ 0.8 near-dup kill, market-relevant filter), pipeline.ts (Promise.allSettled, 15-min TTL cache, in-flight sharing, DB persist, ALL-FAIL → NEWS FEED DEGRADED on last cache).
- GovernedBot refactor: act() split into prepareRebalance (regime→optimizer→AI-merge→constitution) + finalizeRebalance (PROPOSAL→consent→execution→repay). act() = prepare+finalize(null) — REPLAY byte-identical (89/89 green incl. determinism gates). TradeIntent.origin ('optimizer'|'ai_advisor'); CriticEscalation param raises consent bar; APPROVAL_REQUEST cards carry ['A3','A4','CRITIC'] when critic-escalated; EXECUTION entries carry origin. pendingTrades now public (durable approvals).
- types.ts: ScenarioId += 'LIVE' (pseudo-scenario for MetricsEngine in live mode).
- Test updates (intentional renames, documented): radarProviderLabel 'llm' → 'GEMINI'; narrator closer 'The LLM never traded' → 'The AI never traded'. 89/89 pass.

Stage Summary:
- Gemini + news + decision-loop AI scaffolding complete; LIVE session (paper book, prices, market hours) next, then store/API/UI/tests/docs.

---
Task ID: P2-2 (R4 checkpoint + R5 + R6 + R7 core)
Agent: main (Z.ai Code)
Task: LIVE PAPER session, market hours, Yahoo price provider, paper book (mark-to-model bonds), all live API routes, health v2, dashboard redesign (anti-slop terminal).

Work Log:
- live/marketHours.ts: NSE Mon–Fri 09:15–15:30 IST, approximate hardcoded holiday list 2025–26 (documented), MarketStatus pure + testable.
- live/priceProvider.ts: Yahoo chart endpoint (^NSEI, USDINR=X, GC=F) behind PriceProvider interface, 10-min cache, last-known-good fallback, parseYahooChart pure for fixtures.
- live/paperBook.ts: PaperBook extends WorldEngine with LiveScenarioAdapter — real marks applied as RELATIVE moves on calibrated start prices; GSEC/IGCORP/CRED MARK-TO-MODEL (radar-severity × duration × bp spread factors, 0.97 decay); LIQ accrues 4% p.a.; radar raises MTF ratio/CCIL haircut (tighten-only, decaying); regime → ADV mirage. Reuses ledger/impact/margin mechanics verbatim.
- live/liveSession.ts: LiveSession — create/resumeLatest (durable snapshot via BookSnapshot payloadJson; recorder chain RESUMES with prevHash+seq, never resets); pollPrices; refreshRadar (Gemini batch → dictionary fill, a7Apply per event, severity≥4 → one autonomy notch per refresh, REJECTED_BY_A7 entries); advanceDayIfNeeded (once per IST market date, only when open; margin → decay → re-mark → metrics → OBSERVATION + snapshot); rebalance (market-hours gated; news→radar→day→prices→AI advisor→prepareRebalance→AI critic→finalizeRebalance→persist; FORCED_ACTION recorded when forced); decide (durable approvals); stop; state() (full LiveState); generatePostMortem (news citations + AI provenance).
- GovernedBot: prepareRebalance/finalizeRebalance split (async Critic gap); RegimeMachine/AutonomyDial/ConsentQueue serialize/restore; recorder rotation (5MB × keep 10) + resume anchor (verify walks from anchor).
- API: /api/kavach/live/{start,state,poll,rebalance,approve/[id],postmortem,recorder,mode}, /api/cron/news (CRON_SECRET-gated), health v2 (db/gemini/news/price/market/mode/budget). zod + 60/min/IP rate limit on AI-triggering routes (apiHardening.ts).
- store.ts: live session slot with getLive() resume-or-create; checkLlm → geminiStatusSync (no-spend).
- globals.css + page.tsx: anti-slop terminal — #09090B/#101013/#1F1F23 tokens, ONE amber accent #F5A623 (AI moments only), gains #10B981 / losses #EF4444 (money only), Geist Sans + Geist Mono tabular-nums on all mutable figures, 12-col grid, 4px rhythm, section labels 11px uppercase, terminal scrollbars, crossfade ≤120ms, sticky footer. REPLAY LAB (scenario rail w/ kbd hints, transport 1×–8×, A/B chart w/ radar/margin/RBI ReferenceDots + drawdown strip, book table w/ REAL/MTM marks, consent inbox w/ mono counterfactuals, constitution panel, post-mortem sheet) + LIVE PAPER (market status, real marks panel, live NAV + rebalance markers, AI decision-loop table w/ amber edge rows, recorder strip) + mode toggle w/ plain-words confirm modal + keyboard shortcuts (space/←/→/1/2/3/L).
- Prisma client log quieted (log:['error']) — the flight recorder is the audit trail.

Stage Summary:
- LIVE PAPER mode end-to-end on real data (Yahoo + Google News RSS verified live: NIFTY 23,897.7 / USDINR 94.490 / Gold ₹1,35,996/10g; 336 RSS articles). 89/89 tests, lint, tsc all green.

---
Task ID: P2-3 (QA round: bug fixes + features + styling)
Agent: main (Z.ai Code)
Task: agent-browser QA sweep, fix defects found, add autonomy dial + recorder browser, styling detail pass.

Work Log (defects found & fixed):
1. JSX-text `\'` rendered literally in consent empty state → typographic apostrophe.
2. REAL hydration bug: <ul> nested in Radix AlertDialogDescription <p> → invalid HTML + hydration error. Replaced with div-row bullets; verified clean in a fresh browser (zero console errors/warnings).
3. Prices not auto-fetched on LIVE session load → live/state route kicks a background pollPrices() when no lastReal.
4. "Run to the end" button only stepped ONE day: UI sent {n} but route reads {days}. Route now accepts both; UI sends days.
5. Recorder entry-level days lagged trading days by one (SimSession.day updated at end of step) → moved assignment to top of step(); entry.day now equals payload.day. Hash-chain determinism unaffected (both runs of same code agree); 89/89 tests stay green.
6. entryDigest CONSTITUTION counted `c.passed` (undefined) → showed "9 of 9 fired" always. Fixed to `c.pass`.
7. YAxis duplicate ticks on flat series → minTickGap on axes; chart hover cursor via Tooltip cursor prop.

Work Log (features):
- Autonomy dial control (radiogroup, a11y, per-level hints, ratchet-armed lock indicator + recorded RATCHET_BLOCK/AUTONOMY entries) in BOTH modes; new POST /api/kavach/live/mode (ratchet-enforced, recorded); live/persistSnapshot public.
- Flight-recorder AUDIT BROWSER (the regulator surface): RecorderBrowser — day-window paging (±3 days), kind color-coding (margin/forced red, AI amber, approvals amber, releases green), one-line digests per kind (NAV strings, severities, ₹ Cr amounts, % ADV, origin tags), click-to-expand canonical payload JSON, chain-validity + head hash; RecorderStrip gains an "audit" expand button; new GET /api/kavach/live/recorder (zod-validated range query).
- Styling: loading skeletons matching final layout (skeleton-row, sr-only label), edge-active inset amber bar on active scenario, focus-visible 1px amber ring, chart crosshair cursor.

Verification (agent-browser):
- Fresh-browser console: zero errors/warnings (ul/p fixed).
- Consent E2E: press 3 → SUP dial → step → APR-0001..3 cards render → Approve → "APPROVED · Treasury Head" + toast + EXECUTION 'governed:human-approved' recorded with re_clipped flag; run-to-end now completes (day 30).
- Audit browser: entries with hashes, kind digests, payload expand, day paging.
- LIVE: confirm modal plain-words; market CLOSED (weekend, honest); real marks populated via poll; radar feed shows real Google News headlines w/ DICT classification; budget 11/150 visible.
- 89/89 bun tests, eslint clean, tsc clean (src/ only; skills|examples excluded as sandbox residue pending R1-final cleanup).

Stage Summary:
- QA round complete; dashboard now has the dial, the audit browser, skeletons, and no hydration defects. Next: R8 test suites (≥130 total) + R1 repo hygiene files + live smoke data for the honesty report.

---
Task ID: P2-4 (R8 tests + R1 repo hygiene + README)
Agent: main (Z.ai Code)
Task: Phase 2 test suites (145 total), fixtures, GitHub-publishable repo files, README rewrite, final QA.

Work Log:
- tests/fixtures/: googlenews.xml (4 items incl. source-suffix + <source> tag + sports noise), gdelt.json (3 rows incl. title-less), yahoo_nsei.json + yahoo_bad.json.
- tests/kavach-phase2.test.ts — 56 tests, all offline: news adapter parses (5), dedupe/canonicalize/trigram (6), market hours incl. holiday list (4), Yahoo chart parse (2), Gemini adapter mocked paths — schema-valid/invalid/invalid-JSON/429-retry-once/timeout-race/nokey/budget-gate/status (8), A7 forged-loosen incl. "raise the CVaR limit" phrasing (4), advisor constitution clip (5), critic escalation-only + mocked flag (4), LIVE zero-key E2E — market-hours gate/FORCED_ACTION/SKIPPED roles/ledger/durability-across-restart/paper accounting (sell credits cash)/margin tighten-decay/autonomy-one-notch (7), recorder resume + anchor (2), LIVE API routes + zod 400s + cron + page render (7), client-bundle hygiene greps (2).
- PRODUCT BUGS the new tests caught & fixed (the point of R8):
  1. clipAdvisorProposal mixed units (₹ crore proposals vs ₹ caps) — ₹300 Cr passed as "within A3/NAV caps"; now converts once, comparisons in crore. (Engine-side A3 clip was always correct; this fixes the pre-clip labeling + inert NAV cap.)
  2. A7 LOOSEN_ATTEMPT regex missed "raise the CVaR limit to 5%" → widened to `raise [\w\s]{0,12}(limit|cap)`.
  3. parseFinnhub kept "Cricket: India wins" (India regex matched before the noise filter) → sports/entertainment filter now runs FIRST.
  4. advisor.ts missing CR import (runtime crash in clip) → fixed.
- Test seams: __resetGeminiForTests (breaker/limiter/lastOutcome reset — module-global state was bleeding across tests, causing false 'fallback' outcomes).
- Repo hygiene: LICENSE (MIT), CONTRIBUTING.md (constitution-is-the-product ground rules), SECURITY.md (private reporting, key handling, prompt-injection notes), .env.example (every var commented, sane defaults), .gitignore (env/db/data/logs/download), .github/workflows/ci.yml (bun install → prisma → lint → tsc → bun test (offline) → build), vercel.json (15-min /api/cron/news cron), Dockerfile (standalone output) + docker-compose.yml (volumes for ./data + ./db, news-poll sidecar), docs/DEPLOY.md (local/Vercel+Turso/Docker, ≤10 lines each).
- layout.tsx: local public/favicon.svg (terminal shield) replaces the CDN icon; OG metadata added. README.md rewritten: quickstart, two-rooms table, mermaid decision pipeline, anti-1987 story w/ real A/B numbers, constitution table, recorder, LIVE details, calibration actuals (29/29), 145-test matrix, design notes, honest limitations, roadmap, citation spine, MIT + disclaimer.
- Final verification: 145/145 tests, 1159 assertions; bun run lint clean; bunx tsc --noEmit clean (src/); grep -ri "z-ai|z-cdn|webDevReview|sandbox" src/ → empty; dev.log all 200s; fresh-browser console zero errors; final screenshot download/kavach-terminal-final.png.

Stage Summary:
- Phase 2 (SHIP OUT) functionally complete: Gemini layer, real news, AI-in-loop with zero authority, LIVE PAPER on real data, persistence, redesigned terminal, 145 tests, GitHub-ready files.
- Outstanding for the final honesty report: hero GIF from the real app, live-vs-mocked table finalization (Google News RSS + GDELT + Yahoo + cron exercised live this round; Gemini NOT exercised live — no key in this sandbox), the old sandbox webDevReview cron (job 362369) should be deleted via the cron tool when available, and scripts/live-smoke.ts is a dev tool to keep out of CI.

---
Task ID: HANDOVER (end of P2-4 round)
Agent: main (Z.ai Code)

## 1. Current project status / assessment

KAVACH Phase 2 ("SHIP OUT") is functionally complete and stable:
- **Tests**: 145/145 pass, 1159 assertions (target was ≥130). `bun run lint` clean, `bunx tsc --noEmit` clean for src/, grep-audit (`z-ai|z-cdn|webDevReview|sandbox` in src/) empty.
- **Dev server**: healthy on :3000, all routes 200, fresh-browser console zero errors/warnings.
- **Live data verified this round**: Yahoo chart (^NSEI 23,897.7 / USDINR 94.490 / GC=F), Google News RSS (336 articles), GDELT, /api/cron/news — all exercised with real network. Gemini NOT exercised live (no key in sandbox) — dictionary fallbacks verified end-to-end instead (the honest A9 story).
- **Calibration**: 29/29 world gates re-verified via scripts/calibrate.ts; A/B replay numbers in README are from the current build.

## 2. Goals / completed modifications / verification results

Completed this round:
- QA fixes (browser-found): JSX apostrophe, ul-in-p hydration bug, LIVE auto price-fetch, step-route days/n mismatch (broke "run to end"), recorder entry-day off-by-one, CONSTITUTION digest key, YAxis ticks.
- Test-caught product fixes: advisor clip units bug (₹ Cr vs ₹), A7 "raise the CVaR limit" regex, Finnhub sports-first filter, missing CR import.
- Features: autonomy dial (both modes, ratchet-aware, recorded), flight-recorder audit browser (day paging + payload expand), live/mode + live/recorder routes, skeletons, focus-visible, edge-active, chart cursor.
- R8: 56 new offline tests + 5 fixtures. R1: LICENSE/CONTRIBUTING/SECURITY/.env.example/.gitignore/ci.yml/vercel.json/Dockerfile/docker-compose/DEPLOY.md/README/favicon.
- Verified by: bun test (145/0), lint, tsc, agent-browser E2E (scenario start via keyboard, autoplay, SUPERVISED consent cards + approve flow with recorded human-approved execution, audit browser paging, LIVE confirm modal + real marks + real headlines, health v2 truthful incl. budget 125/150 and nokey).

## 3. Unresolved issues / risks / next-phase priorities

1. **Honesty report v2 (final deliverable)**: assemble the live-vs-mocked table (Google News RSS ✓ live, GDELT ✓ live, Yahoo ✓ live, cron ✓ live, Gemini ✗ nokey→mocked/verified-by-fallback), the 12-point slop self-audit, and the "stranger test" (3 commands from a clean clone — cannot be run fully inside this sandbox since the dev server is pre-started; document the equivalent performed here).
2. **Hero GIF (≤10 MB)** from the real app for the README badge row (screenshot exists: download/kavach-terminal-final.png; GIF pending).
3. **Delete the old sandbox webDevReview cron** (job_id 362369 from Phase 1) — the cron tool was unavailable in this request; run `cron delete 362369` when available.
4. **CI caveat**: ci.yml runs `bun run build`; the standalone build with prisma generate has not been executed in-sandbox (dev-server-only environment). First CI run on GitHub may need a prisma generate order tweak.
5. Known limitations (documented in README): Yahoo unofficial, bonds mark-to-model, approximate NSE holidays, Vercel recorder ephemerality, in-memory rate limit.
6. Optional polish: consent-card WebSocket updates for multi-operator rooms; cassette LIVE fixture for UI e2e; Turso-backed recorder.

Priority for next phase: (1) then (2) — they close out the R8 honesty protocol; (3) is one command; (4) is watch-first-run.

---
Task ID: P2-5 (QA round → "Desk Depth" feature round + first-load crash fix)
Agent: main (Z.ai Code)
Task: Assess status, agent-browser QA, then independent feature round: desk-depth surfaces (blotter, risk budget, exports, palette, session history) + styling detail pass.

Work Log:
- Status assessment: 145/145 tests green, lint/tsc clean, dev log all 200s, health v2 truthful (db ok, googlenews 335 articles live, market weekend-closed, budget 141/150). QA sweep (agent-browser): replay start/step/autoplay, consent inbox, LIVE real marks + radar (40 real events), audit browser (59 entries, chain verified), mobile 390px — zero console errors. Verdict: STABLE → chose a feature round per instructions.

FEATURES (backend):
- liveSession.state() now exposes: trades (LiveTrade[] read back from the recorder — EXECUTION/FORCED_SALE only; repay_mtf excluded; origin inferred optimizer|ai_advisor|human|forced; re_clipped flag), risk.grossCap (regime cap exported from governed.ts GROSS_CAP), bucketPerf (cumulative per-sleeve index, day 0 = 100, from dayRets).
- New routes: GET /api/kavach/live/export?kind=recorder|trades|history (JSONL with hashes + Content-Disposition; trades CSV; history CSV from BookSnapshot rows), GET /api/kavach/replay/export?kind=equity|recorder&bot= (A/B equity CSV day,naive_nav_cr,governed_nav_cr,dds; bot JSONL), GET /api/kavach/live/sessions (durable sessions, current flagged).

FEATURES (frontend, page.tsx):
- Session blotter table (origin chips OPT/AI/HUMAN/FORCED with tooltips, ₹ Cr, %ADV, impact, RE-CLIP badge, amber/red left edges for AI/forced, sticky header, total impact in label).
- Risk-budget strip both modes: LIVE (CVaR/limit, gross/regime cap, LIQ/floor — mode 'toward' vs 'coverage' bar semantics), REPLAY (CVaR, peak ADV/A3, |maxDD|/desk stop).
- Sleeve trend sparklines in LIVE book table (64×18 inline SVG polyline + end dot, green/red by direction, +% readout).
- Command palette: ⌘K / Ctrl+K / '?' / header button; filter, ↑↓, Enter, esc; mode-aware commands (crisis replays, transport, post-mortems, LIVE actions, all exports, mode switches); mounted-only-when-open (fresh query each time), autoFocus.
- Exports wired as real <a download> links in Actions (blotter/recorder/history) + Recorder proof (equity/recorder); palette window.open equivalents; post-mortem .md download buttons in both sheets (client Blob).
- SessionHistory panel (left rail, SQLite list, current session amber-flagged, refresh on reset via sessionKey).
- Market countdown when closed: "opens Mon 09:15 IST · in 1d 1h" (client-side, weekend-skipping, honest tooltip: holidays not modeled).

STYLING:
- Radar rows: severity left ticks (sev≥4 red, sev 3 amber).
- Toast slide-up (150ms) + palette drop-in (120ms) keyframes; prefers-reduced-motion kills ALL animation globally.
- .kbd utility (mono hairline chip); footer shortcut chips; header ⌘K button (aria-keyshortcuts).
- Chart terminal end-dots (last-point 2.5px markers on both NAV charts).

DEFECTS FOUND & FIXED (this round — the point of QA):
1. **CRITICAL first-visitor hydration crash** (pre-existing since P2-2, masked because the dev store always had an active replay): with a fresh server and no replay, /state returns {active:false} → effect deps `replay?.scenario.id` and `replay?.bots['governed']` threw TypeError → the whole page was a blank "Application error: a client-side exception". Caught via agent-browser init-script error capture after an OOM restart emptied the store. Fixed: replay?.scenario?.id, replay?.bots?.['governed'] (deps + body + StatusBar + markers memo). Verified: fresh-server empty-state page hydrates with zero errors. This was the "stranger test" bug — would have failed every new visitor.
2. Sessions route: the current RUNNING session fell off the top-12 when newer stopped test sessions existed → route now always includes + flags the current session (fetch-unique + prepend).
3. `.kbd { @apply num ... }` referenced the sibling custom utility `num` → Tailwind 4 build error → whole page 500. Fixed by inlining font-mono tabular-nums.
4. React key warning from recharts custom dot renderers → key={`end-${index}`} added.
5. Test determinism: Gemini mocked tests failed with outcome 'budget' after real live smoke calls exhausted the persisted daily count → MAX_AI_CALLS_PER_DAY raised in those suites' beforeAll; JSONL export test now accepts SESSION_RESUME first-entries (resumed chains legitimately link to the previous head, not genesis).

TESTS: +9 (154/154, 1268 assertions): blotter extraction (origins, A3 on every leg, unique seqs, repay_mtf excluded), grossCap per regime, bucketPerf shape, live export kinds (JSONL chain-linked line-by-line, trades CSV header contract, history CSV), sessions list (current ≤1), replay equity CSV both bots + recorder JSONL + zod 400s, palette/blotter surface greps. Lint clean; tsc clean (src/).

OPERATIONS FINDING (important): the container (4GB) OOM-kills next-server at ~2GB RSS when chrome (~1.2GB) + tests run concurrently — the dev server died repeatedly mid-round (kernel log confirms oom-kill of next-server). Restart command that works: `cd /home/z/my-project && setsid nohup bash -c 'exec bun run dev >> dev.log 2>&1' < /dev/null > /dev/null 2>&1 & disown` then verify with curl. Keep the browser closed when not actively testing. After a restart the in-memory store is empty — which is exactly how the first-visitor crash was found.

VERIFICATION (agent-browser, final): fresh empty-state hydration (title/header/scenarios render, zero errors); replay risk strip + export links; LIVE: risk budget bars (honest red CVaR 4.0/2.0 after news tightening), blotter (2 OPT legs after forced rebalance), session history (current flagged RUNNING ₹999.8 Cr), countdown, Trend column, export links; palette open/filter/execute (Poll action ran, toast shown); mobile 390px zero errors; console zero errors/warnings. VLM design review: "functional, professional-grade tool", defects noted are honest day-0 empty states (flat NAV chart, truncated headlines carry tooltips).

Stage Summary:
- P2-5 shipped: the console gained the desk surfaces (blotter, risk budget, palette, exports, session history, countdown, sparklines) and a critical first-load crash was found and fixed — the app now survives the true stranger test. 154/154 tests.
- Outstanding: (1) old sandbox webDevReview cron job 362369 STILL not deletable (cron tool unavailable both rounds — retry next round); (2) hero GIF for README; (3) honesty-report live-vs-mocked table finalization; (4) dev server OOM under combined load — consider next.config webpack/turbopack memory tuning or documenting the restart command in DEPLOY.md; (5) CI first-run watch (prisma generate order).
---
Task ID: P2-6 (QA round → 3 bug fixes + "Stress Lens" feature round + styling depth)
Agent: main (Z.ai Code)
Task: Assess status, agent-browser QA, fix discovered bugs, then independent feature round (stress lens, radar drawer, shortcuts, budget meter) + mandatory styling pass.

Work Log:
- STATUS ASSESSMENT: 154/154 tests green at round start; dev server healthy; health v2 truthful. Chose bug-fix-first after DB inspection found three real defects, then a feature round.

PRODUCT BUGS FOUND & FIXED (the point of QA):
1. **AI budget counted rows it never paid for** (design bug, pre-existing): `aiBudgetUsedToday()` counted ALL aiCall rows — nokey, probe, budget-gate rows that never touched the Gemini API. In zero-key operation the counter climbs on dictionary traffic alone and the app falsely shows "AI BUDGET SPENT" (health showed used=328/150 today with zero real API calls ever made). Fix: new `counted` column (Prisma schema + db push); audit rows carry counted:true ONLY for real network attempts (ok / rejected / timeout / rate_limited / network-fallback). Budget query filters counted:true. Production DB then honestly reports 0/150.
2. **Test suite polluted the production DB**: bun test auto-loads .env (DATABASE_URL=db/custom.db) — every mocked Gemini test wrote audit rows into prod and inflated the budget. Fix: tests/_db-env.ts sets DATABASE_URL to throwaway db/test.db as the FIRST import of both test files (before any src import constructs the PrismaClient); scripts/push-test-db.ts creates it; CI gains a "Create throwaway test DB" step. Self-seeding budget-gate tests re-verified under the new semantics.
3. **GDELT silently lied**: upstream etiquette throttle answers HTTP 200 + a TEXT body; the old Promise.allSettled-of-6-concurrent-queries parser swallowed it and health reported `gdelt ok:true count:0`. Fix: queries serialized (≤1 req/5s etiquette gap, 2-query cap, 6s timeouts ≈ 17s worst case), throttle body detected via isGdeltThrottleText, all-queries-failed → provider throws → pipeline records ok:false + lastError. Cron E2E test timeout raised to 45s for the serialized budget.
4. Dev-server E2E suites hard-required a :3000 server → would fail in CI. Fix: tests/_dev-server.ts probes once (2s timeout) + describe.skipIf — CI runs the offline matrix, local runs full.
5. Cosmetic-but-real: first-visitor empty-state guidance ("Pick a crisis" panel) now teaches the keyboard (1/2/3/space).

FEATURES (this round — mandatory feature depth):
- **Stress Lens (what-if pre-mortem)** — the hero feature: GET /api/kavach/live/stress?scenario= (zod-gated) + src/lib/kavach/live/stressLens.ts (pure, deterministic). Projects TODAY's live book through a scripted crisis as buy-and-hold counterfactual (no trades, no constitution action, LIQ accrues, MTF interest drag). Returns NAV path + drawdown, maxDD vs the −10% desk stop, tail CVaR vs the A4 CRISIS limit, post-stress LIQ+cash vs the A1 floor, per-sleeve scripted damage, and an honest disclaimer. UI: StressLensSheet (bottom sheet) with scenario tabs, projected NAV chart (amber line + desk-stop reference line + day-0 baseline), drawdown strip, 4 verdict rows (PASS/FAIL chips), sleeve-damage bars; opened from a LIVE Actions button, ⌘K palette commands (mode-switching), all recorded nowhere because it executes nothing.
- **Radar detail drawer**: every radar row is now clickable (role=button, keyboard Enter/Space) → right-side drawer with full headline, severity/event/direction/confidence/source/classifier/latency, A7 effect (tightened vs inert), source link, and the prompt-injection/A7 honesty note. RadarFeed manages selection internally; the inline source link stops propagation.
- **Keyboard shortcuts sheet**: '/' opens a dedicated legend (8 shortcuts with kbd chips, when-column, keyboard-first note); palette gains a help command; footer gains a `/ keys` chip.
- **AI budget meter** in the status bar: micro progress bar (used/limit) with amber when spent + honest tooltip (network attempts only, persisted).
- Palette + stress-lens commands wired through Page-level state (mode-switch + sheet open with preselected crisis).

STYLING (mandatory detail pass, all within the token discipline):
- flash-num keyframe (650ms amber pulse on value change) + useFlash hook (lint-clean: setState only inside timeout callbacks) applied to LIVE NAV/since-start rows.
- drawer-in slide (150ms) for the radar drawer; reduced-motion still kills all animation globally.
- LiveNavChart gains a day-0 NAV hairline reference line; stress chart adds the desk-stop line + baseline.
- Radar rows: hover bg + cursor + severity ticks (kept); source link propagation fixed.
- Empty replay state: kbd-chip guidance instead of a bare sentence.
- Verified the palette/shortcuts/drawer widths are w-[min(...)] (an earlier "w-in(" reading was a terminal display artifact of `[m` — od -c confirmed the source was always correct).

TESTS: +18 (172/172, 1318 assertions): stress lens pure suite (shape/day-0 identity/direction EQ↓ GOLD↑/ILFS worst=CRED/determinism/COVID desk-stop breach with breachDay/honest disclaimer), GDELT suite (throttle-text detection, all-throttled→throws, partial success resolves, serialized gaps measured, query cap), budget semantics (nokey not counted, mocked ok counted), stress route E2E (200 + 31 path points + 4 verdicts; bogus→400), console-surface greps (sheet/drawer/shortcuts/flash/budget meter/A7 text/'/' binding/CSS keyframes).

VERIFICATION (agent-browser, under a hostile 4GB container):
- Fresh stranger load: terminal renders, zero console errors/warnings (multiple independent cycles).
- Shortcuts sheet via '/' and palette via '?' — both verified open with content; screenshots captured.
- LIVE mode via the confirm modal: LIVE BOOK with real marks (NIFTY 23,897.7 · USD/INR 94.490 · Gold ₹1,35,996), market-closed countdown "opens Mon 09:15 IST", honest budget meter "0/150". Screenshots: download/kavach-p26-{fresh-load,shortcuts,palette,live,live2,mobile,stress-lens}.png.
- Stress lens sheet opens with scenario tabs (data fetch raced a server death in one cycle; the route + full payload verified 200 via curl + E2E test instead).
- Page recovers from server bounces (transient-error handling) — verified repeatedly, involuntarily.

OPERATIONS (documented for the next agent):
- The container (4GB) OOM-kills next-server whenever chrome launches (17 procs ≈ 1.4GB) while the server is ≥1.4GB, and again on each Turbopack route compile with the page open. Working patterns: (a) chrome about:blank FIRST (with `echo 1000 > /proc/$PID/oom_score_adj` on all chrome PIDs so the killer prefers chrome), THEN start the server, THEN navigate; (b) warm all routes via curl with chrome closed; (c) drive actions via in-page `fetch` evals; (d) after any server death, the loaded page self-recovers its pollers. Server-only flows are stable indefinitely; interactive browser sessions live ~30–60s per compile.
- Dev server restart command (works): `cd /home/z/my-project && setsid nohup bash -c 'exec bun run dev >> dev.log 2>&1' < /dev/null > /dev/null 2>&1 & disown`.

Stage Summary:
- P2-6 shipped: three honesty bugs fixed (budget semantics, test-DB isolation, GDELT throttle), one hero feature (Stress Lens), three desk features (radar drawer, shortcuts sheet, budget meter), a styling depth pass, +18 tests → 172/172. The app is more honest (budget/GDELT) and more useful (pre-mortem lens) than at round start.
- Outstanding: (1) old sandbox webDevReview cron 362369 still not deletable (cron tool unavailable again this round); (2) hero GIF for README; (3) browser-visual capture of the stress-lens chart with data + radar drawer open raced container OOM — code-complete and API/E2E-verified, but a screenshot with rendered chart is pending for a luckier memory window; (4) container memory vs chrome documented above; (5) CI first-run watch (prisma order + test-DB step now included).

---
Task ID: P2-7 (final verification + repo hygiene completion + ship-out report)
Agent: main (Z.ai Code)
Task: User asked to finish fast. Verified full app end-to-end, completed remaining R1 hygiene items, confirmed health/tests/lint, delivered the final honest report.

Work Log:
- Found dev server dead (known 4GB OOM). Restarted via documented command; health v2 fully truthful: db ok, gemini nokey, news providers registered (2 zero-key enabled, 3 keyed disabled), market WEEKEND closed, budget 0/150, mode idle.
- R1 audit completed for real this time: removed leftover sandbox scaffolding scripts (tests/python-runtime-container.sh, python-runtime-build.sh, database-runtime-build.sh). `rg -il "z-ai|webdevreview|sandbox" src/ prisma/ tests/ scripts/` now returns NOTHING (exit 1). src/ had been clean already.
- .gitignore extended: tool-results/, skills/, examples/, .zscripts/ marked as sandbox scaffolding (not shipped) — GitHub clone stays clean without breaking sandbox tooling.
- Cron job 362369 inspected with the (now available) cron tool: it IS the mandated 15-min webDevReview QA job with the exact required description; its recent failures are platform-side ("model glm-5.3 concurrency limit exceeded"), not app defects. Left in place as required; noted for the user.
- agent-browser E2E (OOM-safe short sessions): fresh load hydrates with ZERO console errors/warnings; title "KAVACH — Event-Aware Capital Governor"; keyboard `3` selects COVID-2020 → Run-to-end → d30/30 complete, A/B verdict rendered (NaiveBot −₹109.39 Cr vs KAVACH −₹32.11 Cr, +₹77 Cr difference), radar rows clickable, state API complete:true. LIVE PAPER: consent modal → LIVE BOOK ₹1,000 Cr (EQ 50/GSEC 25/IGCORP 20/CRED 10/GOLD 10 + LIQ), MARKET CLOSED weekend honesty, budget meter, live/state API 200. Screenshots: download/kavach-final-check.png, kavach-final-live.png. Browser closed immediately after.
- Lint: exit 0. Tests: 172 total (150 pass + 22 dev-server E2E skip offline, 0 fail) — unchanged, as file removals were non-test scaffolding.

Stage Summary:
- SHIP OUT complete. App is browser-verified, grep-clean, lint-clean, test-green, deploy-documented (README + docs/DEPLOY.md + Dockerfile + vercel.json). Final honest report delivered to the user.
- Outstanding (cosmetic): hero GIF for README; platform-side cron model-concurrency failures; 4GB container OOM when chrome + server co-run (restart command documented in this worklog).
