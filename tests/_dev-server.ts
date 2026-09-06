/**
 * Dev-server probe for the E2E suites. When no server listens on :3000
 * (e.g. CI, which runs the offline matrix only), those suites skip
 * instead of failing. Probe once with a short timeout.
 */
import './_db-env';

export const devServerUp: boolean = await fetch(
  'http://localhost:3000/api/kavach/health',
  { signal: AbortSignal.timeout(2000) }
)
  .then((r) => r.ok)
  .catch(() => false);
