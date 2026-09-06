/**
 * Test DB isolation — MUST be the first import of every test file.
 *
 * `bun test` auto-loads `.env` (which points DATABASE_URL at the production
 * db/custom.db). Without this module, every mocked Gemini call writes audit
 * rows into the production DB and inflates the daily AI budget counter —
 * the app then reports "AI BUDGET SPENT" with zero real API calls.
 *
 * This module redirects the Prisma client to a throwaway db/test.db BEFORE
 * any src module (and thus the PrismaClient singleton) is constructed.
 * Run `bun scripts/push-test-db.ts` once after schema changes.
 */
process.env.DATABASE_URL = `file:${new URL('../db/test.db', import.meta.url).pathname}`;
