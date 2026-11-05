import type { AppEnv } from '../types';

const NON_PRODUCTION_ENVIRONMENTS = new Set(['staging', 'preview', 'development', 'test', 'local']);

function explicitEnvironment(env?: AppEnv): string {
  return String(env?.SONIC_ENV || '').trim().toLowerCase();
}

function nodeEnvironmentIsProduction(): boolean {
  return typeof process !== 'undefined'
    && String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

export function isCloudflarePages(env?: AppEnv): boolean {
  const e = (env || {}) as Record<string, unknown>;
  return Boolean(
    String(e.CF_PAGES || '').trim() ||
    String(e.CF_PAGES_BRANCH || '').trim() ||
    String(e.CF_PAGES_URL || '').trim(),
  );
}

function resolveExplicitProduction(explicit: string): boolean | null {
  if (!explicit) return null;
  if (explicit === 'production') return true;
  if (NON_PRODUCTION_ENVIRONMENTS.has(explicit)) return false;
  // Unknown values such as `prod` or a typo must not silently disable gating.
  return true;
}

/**
 * Production detection for server-side policy (content licensing, release
 * readiness, rate limiting). LinuEngine deployments are production when the
 * image exposes NODE_ENV=production or SONIC_ENV=production; local runs remain
 * permissive unless explicitly marked.
 */
export function isProductionEnvironment(env?: AppEnv): boolean {
  const explicit = resolveExplicitProduction(explicitEnvironment(env));
  if (explicit !== null) return explicit;
  if (isCloudflarePages(env)) return true;
  return nodeEnvironmentIsProduction();
}

/**
 * Production detection for browser-facing access gating.
 *
 * Cloudflare Pages exposes CF_PAGES_BRANCH for both production and preview
 * builds, so a non-main production branch cannot be distinguished from a
 * preview branch at runtime. Without an explicit SONIC_ENV we therefore fail
 * closed and treat any Pages deployment as production. Preview deployments can
 * opt out explicitly with SONIC_ENV=preview or SONIC_ENV=staging.
 *
 * A Pages deployment that accidentally carries SONIC_RUNTIME=linux-engine is
 * still treated as Pages; only the standalone engine is exempt from the
 * browser access gate (it is protected by the engine secret instead).
 */
export function isProductionDeployment(env?: AppEnv): boolean {
  if (isCloudflarePages(env)) {
    const explicit = resolveExplicitProduction(explicitEnvironment(env));
    return explicit === null ? true : explicit;
  }

  if (String(env?.SONIC_RUNTIME || '').trim().toLowerCase() === 'linux-engine') return false;

  const explicit = resolveExplicitProduction(explicitEnvironment(env));
  if (explicit !== null) return explicit;

  return nodeEnvironmentIsProduction();
}
