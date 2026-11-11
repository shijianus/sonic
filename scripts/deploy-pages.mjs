import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { buildPagesDeploymentTree, parseDeploymentOrigin, readStagingAcceptance } from './pages-release-lib.mjs';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production promotion`);
  return value;
}

function deploy() {
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
  if (!/^[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*$/.test(requireEnv('SONIC_ALLOWED_SOURCES'))) {
    throw new Error('SONIC_ALLOWED_SOURCES must be a comma-separated list of approved source IDs');
  }
  const verifyOrigin = parseDeploymentOrigin(requireEnv('SONIC_DEPLOY_VERIFY_URL'));
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
    readStagingAcceptance(acceptanceFile, manifest, pagesArtifactDigest, { production: true });

    const wranglerCli = process.env.WRANGLER_CLI;
    const wranglerBin = process.env.WRANGLER_BIN || 'npx';
    const command = wranglerCli ? process.execPath : wranglerBin;
    // Use the installed, lockfile-pinned Wrangler.
    const prefix = wranglerCli ? [wranglerCli] : wranglerBin === 'npx' ? ['--no-install', 'wrangler'] : [];
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

    const verified = spawnSync(process.execPath, ['scripts/verify-deployed-release.mjs', verifyOrigin], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SONIC_DEPLOY_ENV: 'production',
        SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: pagesArtifactDigest,
      },
      stdio: 'inherit',
    });
    if (verified.status !== 0) {
      throw new Error('Deployment is live but failed verification. Restore the last known good release using the rollback runbook.');
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try {
  deploy();
} catch (error) {
  console.error(`[deploy] ${error.message}`);
  process.exitCode = 1;
}
