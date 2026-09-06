# Deploying KAVACH

Two supported paths, both ≤ 10 lines of user action. Everything degrades
gracefully with zero API keys — you only add keys to make the AI live.

## 1. Local (any machine with Bun 1.x)

```bash
git clone https://github.com/<you>/kavach && cd kavach
bun install
cp .env.example .env        # optional: add GEMINI_API_KEY later
bunx prisma db push
bun run dev                 # http://localhost:3000
```

## 2. Vercel (+ Turso for durable state)

1. Push the repo to GitHub; import it in Vercel (framework auto-detected).
2. Create a Turso database: `turso db create kavach` then
   `turso db show kavach --url` and `turso db tokens create kavach`.
3. In Vercel → Settings → Environment Variables, add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `libsql://kavach-<you>.turso.io` |
   | `GEMINI_API_KEY` | your Google AI Studio key (optional) |
   | `GEMINI_MODEL` | `gemini-2.5-flash` (default) |
   | `GNEWS_API_KEY` / `MARKETAUX_API_KEY` / `FINNHUB_API_KEY` | optional keyed news |
   | `MAX_AI_CALLS_PER_DAY` | `150` (default) |
   | `CRON_SECRET` | any random string (protects the cron endpoint) |

4. Deploy. `vercel.json` registers the 15-minute `/api/cron/news` cron.
5. Run `bunx prisma db push` once against Turso to create the tables.

## 3. Docker / self-host

```bash
git clone https://github.com/<you>/kavach && cd kavach
docker compose up -d --build
# → http://localhost:3000 ; state persists in ./db and ./data
```

`docker-compose.yml` includes a sidecar that hits `/api/cron/news` every
15 minutes (the self-host stand-in for Vercel Cron).

## Operational notes

- **Zero-key mode**: Gemini absent → dictionary radar (A9 fail-safe), the
  Advisor/Critic are recorded as `SKIPPED`, LIVE PAPER still runs on Yahoo
  prices + Google News RSS + GDELT (no keys needed for either).
- **Free-tier discipline**: one batched radar call per 15 minutes (≤ 20
  headlines), one advisor + one critic per rebalance, client-side ≤ 8
  req/min, and a hard `MAX_AI_CALLS_PER_DAY` counter persisted in the DB.
- **The DB is state; the recorder is proof.** Sessions, approvals, radar
  events and AI-call audits live in SQLite/Turso. The hash-chained JSONL
  flight recorder under `data/flightrecorder/` is the audit artifact —
  back it up independently. Local deploys persist it via the `./data`
  volume; Vercel deploys should treat it as ephemeral per-instance
  (documented limitation — Turso holds the durable state).
- **Yahoo Finance chart endpoint** is unofficial and can rate-limit or
  change; the app caches 10 minutes and serves last-known-good with a
  visible `stale` flag. Bonds are mark-to-model by design (no free Indian
  bond tickers exist) and labeled `MTM` in the UI.
- **Market-hours gate**: LIVE rebalances fire only Mon–Fri 09:15–15:30 IST
  against an approximate hardcoded holiday list (see README limitations).
