/** Push the Prisma schema to the throwaway test DB (db/test.db). */
process.env.DATABASE_URL = `file:${new URL('../db/test.db', import.meta.url).pathname}`;

import { execSync } from 'child_process';

execSync('bunx prisma db push --skip-generate --accept-data-loss', {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
});
console.log('test db ready at', process.env.DATABASE_URL);
