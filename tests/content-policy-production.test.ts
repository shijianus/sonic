import { describe, expect, it } from 'vitest';
import {
  evaluateContentFlags,
  getContentPolicyMode,
  getContentPolicyReadiness,
} from '../functions/_lib/sonic/licensing';
import { isProductionDeployment, isProductionEnvironment } from '../functions/_lib/sonic/environment';
import type { AppEnv } from '../functions/_lib/types';

const production = (extra: Record<string, unknown> = {}): AppEnv => ({
  SONIC_ENV: 'production',
  ...extra,
}) as AppEnv;

describe('production content licensing is fail-closed', () => {
  it('disables every source when a production deployment has no policy', () => {
    for (const env of [
      production(),
      { CF_PAGES_BRANCH: 'main' } as AppEnv,
      { SONIC_ENV: 'prod' } as AppEnv,
      { CF_PAGES_BRANCH: 'release-2026', SONIC_RUNTIME: 'linux-engine' } as AppEnv,
    ]) {
      expect(isProductionEnvironment(env)).toBe(true);
      const flags = evaluateContentFlags(env);
      expect(flags.policyMode).toBe('strict-allowlist');
      expect(flags.enableNetease).toBe(false);
      expect(flags.enableQq).toBe(false);
      expect(flags.enableKugou).toBe(false);
      expect(flags.enableKuwo).toBe(false);
      expect(flags.enableAmll).toBe(false);
      expect(flags.enableLrclib).toBe(false);
      expect(flags.enableGdstudio).toBe(false);
      expect(flags.enableLyriva).toBe(false);
      expect(flags.enableUnblock).toBe(false);
      expect(flags.enableSynthetic).toBe(false);
    }
    expect(getContentPolicyMode(production())).toBe('strict-allowlist');
  });

  it('rejects default, empty and PROHIBITED production allowlists', () => {
    expect(getContentPolicyReadiness(production({ SONIC_CONTENT_POLICY: 'default' }))).toMatchObject({
      ok: false,
      reason: 'strict_allowlist_required',
    });
    expect(getContentPolicyReadiness(production({ SONIC_CONTENT_POLICY: 'strict-allowlist' }))).toMatchObject({
      ok: false,
      reason: 'allowed_sources_required',
    });
    expect(getContentPolicyReadiness(production({
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'gdstudio,lyriva,unblock',
    }))).toMatchObject({
      ok: false,
      reason: 'unapproved_sources',
      invalidSources: ['gdstudio', 'lyriva', 'unblock'],
    });
  });

  it('accepts the directly authorized commercial sources for production playback and lyrics', () => {
    const env = production({
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'netease,qq,kugou,kuwo,amll,lrclib',
    });
    expect(getContentPolicyReadiness(env)).toMatchObject({
      ok: true,
      allowedSources: ['amll', 'kugou', 'kuwo', 'lrclib', 'netease', 'qq'],
      effectiveSources: ['netease', 'qq', 'kugou', 'kuwo', 'amll', 'lrclib'],
      invalidSources: [],
    });
    const flags = evaluateContentFlags(env);
    expect(flags.enableNetease).toBe(true);
    expect(flags.enableQq).toBe(true);
    expect(flags.enableKugou).toBe(true);
    expect(flags.enableKuwo).toBe(true);
    expect(flags.enableAmll).toBe(true);
    expect(flags.enableLrclib).toBe(true);
    expect(flags.enableGdstudio).toBe(false);
    expect(flags.enableLyriva).toBe(false);
    expect(flags.enableUnblock).toBe(false);
  });

  it('accepts an approved allowlist only when a runtime-enabled audio source remains', () => {
    const syntheticOnly = production({
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'synthetic',
      SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
    });
    expect(getContentPolicyReadiness(syntheticOnly)).toMatchObject({
      ok: false,
      reason: 'no_runtime_enabled_sources',
      effectiveSources: [],
    });
    expect(evaluateContentFlags(syntheticOnly).enableSynthetic).toBe(false);

    // Catalog/lyrics-only sources (including Apple without a token) do not make
    // a music deployment ready; at least one audio source must be enabled.
    const apple = production({
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'apple',
      SONIC_APPLE_MUSIC_TOKEN: 'test-token',
    });
    expect(getContentPolicyReadiness(apple)).toMatchObject({
      ok: false,
      reason: 'no_runtime_enabled_sources',
      effectiveSources: ['apple'],
    });

    const appleWithoutToken = production({
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'apple',
    });
    expect(getContentPolicyReadiness(appleWithoutToken)).toMatchObject({
      ok: false,
      reason: 'no_runtime_enabled_sources',
    });
  });

  it('fails closed on an unknown content policy in every environment', () => {
    const staging = { SONIC_ENV: 'staging', SONIC_CONTENT_POLICY: 'strict-alowlist' } as AppEnv;
    expect(getContentPolicyMode(staging)).toBe('strict-allowlist');
    expect(getContentPolicyReadiness(staging)).toMatchObject({
      ok: false,
      reason: 'invalid_content_policy',
    });
    expect(evaluateContentFlags(staging).enableNetease).toBe(false);

    const local = { SONIC_CONTENT_POLICY: 'standrad' } as AppEnv;
    expect(getContentPolicyMode(local)).toBe('strict-allowlist');
    expect(getContentPolicyReadiness(local).ok).toBe(false);
    expect(evaluateContentFlags(local).enableQq).toBe(false);
  });

  it('never enables PROHIBITED sources in standard/local mode even when env flags are set', () => {
    const env = {
      SONIC_ENV: 'development',
      SONIC_ENABLE_GDSTUDIO: '1',
      SONIC_ENABLE_LYRIVA: '1',
      SONIC_ENABLE_UNBLOCK: '1',
    } as AppEnv;
    const flags = evaluateContentFlags(env);
    expect(flags.policyMode).toBe('default');
    expect(flags.enableGdstudio).toBe(false);
    expect(flags.enableLyriva).toBe(false);
    expect(flags.enableUnblock).toBe(false);
    expect(getContentPolicyReadiness(env).ok).toBe(true);
  });

  it('keeps the browser access gate production-aware on Pages even with a stray engine runtime', () => {
    expect(isProductionDeployment({ CF_PAGES_BRANCH: 'main', SONIC_RUNTIME: 'linux-engine' } as AppEnv)).toBe(true);
    expect(isProductionDeployment({ SONIC_RUNTIME: 'linux-engine' } as AppEnv)).toBe(false);
    expect(isProductionDeployment({ SONIC_ENV: 'staging', CF_PAGES_BRANCH: 'preview' } as AppEnv)).toBe(false);
  });
});
