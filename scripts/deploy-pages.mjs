import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPagesDeploymentTree, deploymentSourceIds, parseDeploymentOrigin, readStagingAcceptance, verifyProductionPagesBinding } from './pages-release-lib.mjs';

const require = createRequire(import.meta.url);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production promotion`);
  return value;
}

async function deploy({ preflight }) {
  const project = requireEnv('CF_PAGES_PROJECT');
  const branch = requireEnv('CF_PAGES_BRANCH');
  if (project === 'sonic-staging' || (process.env.SONIC_DEPLOY_ENV || 'production') !== 'production') {
    throw new Error('Use scripts/prepare-pages-preview.mjs for an isolated Staging deployment');
  }
  if (!/^[a-z0-9-]{1,63}$/.test(project) || !/^[a-zA-Z0-9._/-]{1,128}$/.test(branch)) {
    throw new Error('Invalid Pages project or branch name');
  }
  if (requireEnv('SONIC_ENV') !== 'production') throw new Error('SONIC_ENV must be production');
  if (!['open', 'invite'].includes(requireEnv('SONIC_ACCESS_MODE'))) {
    throw new Error('SONIC_ACCESS_MODE must be explicitly open or invite');
  }
  if (process.env.SONIC_RUNTIME?.trim().toLowerCase() === 'linux-engine') {
    throw new Error('SONIC_RUNTIME=linux-engine is invalid for Pages');
  }
  if (requireEnv('SONIC_CONTENT_POLICY') !== 'strict-allowlist') {
    throw new Error('SONIC_CONTENT_POLICY must be strict-allowlist');
  }
  const allowedSources = requireEnv('SONIC_ALLOWED_SOURCES');
  if (!/^[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*$/.test(allowedSources)) {
    throw new Error('SONIC_ALLOWED_SOURCES must be a comma-separated list of approved source IDs');
  }
  const verifyOrigin = parseDeploymentOrigin(requireEnv('SONIC_DEPLOY_VERIFY_URL'));
  const engineOrigin = parseDeploymentOrigin(requireEnv('SONIC_DEPLOY_VERIFY_ENGINE_URL'));
  if (verifyOrigin === engineOrigin) throw new Error('Pages and Engine verification require distinct origins');
  if (new URL(verifyOrigin).hostname.split('.').includes('sonic-staging')) {
    throw new Error('Production verification requires the production origin');
  }
  if (requireEnv('SONIC_ENGINE_SECRET').length < 32) {
    throw new Error('SONIC_ENGINE_SECRET is too short for protected health verification');
  }
  const acceptanceFile = requireEnv('SONIC_PRODUCTION_ACCEPTANCE_FILE');

  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Production promotion requires a clean working tree');
  const head = git('rev-parse', 'HEAD');
  const { stagingRoot, manifest, pagesArtifactDigest } = buildPagesDeploymentTree(process.cwd());
  try {
    if (manifest.dirty || manifest.baseCommit !== head) {
      throw new Error('Production promotion requires a clean release manifest for the checked-out commit');
    }
    readStagingAcceptance(acceptanceFile, manifest, pagesArtifactDigest, {
      production: true, productionSources: deploymentSourceIds(allowedSources),
    });
    await verifyProductionPagesBinding({ pagesOrigin: verifyOrigin, engineOrigin });

    const verify = (...args) => {
      const result = spawnSync(process.execPath, ['scripts/verify-deployed-release.mjs', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, SONIC_DEPLOY_ENV: 'production', SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: pagesArtifactDigest },
        stdio: preflight ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      });
      if (result.error) throw result.error;
      return result.status === 0;
    };
    if (!verify('--engine-only', engineOrigin)) {
      throw new Error('Production Engine preflight failed before uploading Pages');
    }
    if (preflight) {
      return {
        ok: true, decision: 'GO', mode: 'production-preflight', project, branch,
        baseCommit: manifest.baseCommit, releaseId: manifest.releaseId,
        sourceDigest: manifest.sourceDigest, pagesArtifactDigest,
      };
    }

    const wranglerBin = process.env.WRANGLER_BIN?.trim();
    const configuredCli = process.env.WRANGLER_CLI?.trim();
    const wranglerCli = configuredCli ? resolve(configuredCli)
      : !wranglerBin || wranglerBin === 'npx' ? resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
      : undefined;
    const command = wranglerCli ? process.execPath : wranglerBin;
    const prefix = wranglerCli ? [wranglerCli] : [];
    const args = [...prefix, 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch,
      '--commit-hash', manifest.baseCommit, '--commit-dirty=false'];
    console.log(`[deploy] project=${project} branch=${branch} release=${manifest.releaseId} pages=${pagesArtifactDigest}`);
    const result = spawnSync(command, args, {
      cwd: stagingRoot,
      env: process.env,
      stdio: 'inherit',
      shell: !wranglerCli && process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Wrangler exited with status ${result.status ?? 'unknown'}`);

    if (!verify(verifyOrigin)) {
      throw new Error('Deployment is live but failed verification. Restore the last known good release using the rollback runbook.');
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { values: { preflight } } = parseArgs({ options: { preflight: { type: 'boolean' } } });
  try {
    const decision = await deploy({ preflight });
    if (preflight) console.log(JSON.stringify(decision));
  } catch (error) {
    if (preflight) {
      console.log(JSON.stringify({ ok: false, decision: 'BLOCK', mode: 'production-preflight', reason: error.message }));
    }
    throw error;
  }
}

main().catch(error => {
  console.error(`[deploy] ${error.message}`);
  process.exitCode = 1;
});
