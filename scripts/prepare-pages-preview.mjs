import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPagesDeploymentTree, readStagingAcceptance } from './pages-release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const promote = process.argv.includes('--promote-staging');
const project = process.env.CF_PAGES_PROJECT || 'sonic-staging';
if (project !== 'sonic-staging') throw new Error('This command only publishes sonic-staging');

const { stagingRoot, manifest, pagesArtifactDigest } = buildPagesDeploymentTree(root);
let prepared = false;
try {
  const branch = promote ? 'staging' : process.env.CF_PAGES_BRANCH || `rc-${manifest.sourceDigest.slice(0, 12)}`;
  if ((!promote && branch === 'staging') || !/^[a-z0-9-]{1,63}$/.test(branch)) {
    throw new Error('Stable staging requires explicit promotion from an isolated preview');
  }
  if (promote) {
    const acceptancePath = process.env.SONIC_STAGING_ACCEPTANCE_FILE || 'reports/release-readiness/accepted-preview.json';
    readStagingAcceptance(resolve(root, acceptancePath), manifest, pagesArtifactDigest);
  }
  const shouldDeploy = process.argv.includes('--deploy');
  const cli = process.env.WRANGLER_CLI;
  if (shouldDeploy && (!cli || !existsSync(cli))) throw new Error('Set WRANGLER_CLI to an installed wrangler/bin/wrangler.js');
  const result = { project, branch, stagingRoot, manifest, pagesArtifactDigest };
  const descriptor = resolve(root, promote ? 'reports/release-readiness/latest-staging-package.json' : 'reports/release-readiness/latest-pages-package.json');
  mkdirSync(dirname(descriptor), { recursive: true });
  writeFileSync(descriptor, JSON.stringify(result, null, 2) + '\n');
  prepared = true;
  console.log(JSON.stringify(result, null, 2));
  if (shouldDeploy) {
    const deployment = spawnSync(process.execPath, [cli, 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, '--commit-hash', manifest.baseCommit, `--commit-dirty=${Boolean(manifest.dirty)}`], {
      cwd: stagingRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    if (deployment.error) throw deployment.error;
    process.exitCode = deployment.status ?? 1;
  }
} finally {
  if (!prepared) rmSync(stagingRoot, { recursive: true, force: true });
}
