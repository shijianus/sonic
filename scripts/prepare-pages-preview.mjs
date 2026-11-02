import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyReleaseInputs, excludedReleasePath, verifyRelease } from './release-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'dist/release.json');
if (!existsSync(manifestPath)) throw new Error('Build the release first: npm run build');
const verified = verifyRelease(root, { manifestPath: 'dist/release.json' });
const { manifest } = verified;
const stagingRoot = mkdtempSync(join(tmpdir(), 'sonic-pages-release-'));
copyReleaseInputs(root, stagingRoot, verified.files.filter(file => file.path.startsWith('functions/') || ['package.json', 'package-lock.json', 'tsconfig.json'].includes(file.path)));
cpSync(resolve(root, 'dist'), join(stagingRoot, 'dist'), {
  recursive: true, errorOnExist: true, force: false,
  filter: path => {
    const name = path.slice(resolve(root, 'dist').length + 1).replaceAll('\\', '/');
    // Vite's .js.gz/.css.gz files are build output, not source archives.
    if (excludedReleasePath(name.replace(/\.gz$/i, ''))) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`Link not allowed in Pages output: ${name}`);
    return true;
  },
});
const compiledPath = join(stagingRoot, 'functions/_lib/sonic/compiled-release.ts');
const identity = {
  baseCommit: manifest.baseCommit,
  sourceDigest: manifest.sourceDigest,
  releaseId: manifest.releaseId,
  buildTime: manifest.buildTime,
  dirty: manifest.dirty,
};
writeFileSync(compiledPath, `export const COMPILED_RELEASE = ${JSON.stringify(identity)};\n`);
const promote = process.argv.includes('--promote-staging');
const branch = promote ? 'staging' : process.env.CF_PAGES_BRANCH || `rc-${manifest.sourceDigest.slice(0, 12)}`;
const project = process.env.CF_PAGES_PROJECT || 'sonic-staging';
if (project !== 'sonic-staging' || (!promote && branch === 'staging') || !/^[a-z0-9-]{1,63}$/.test(branch)) {
  throw new Error('This command only publishes sonic-staging, with stable promotion explicitly gated');
}
if (promote) {
  const evidence = JSON.parse(readFileSync(resolve(root, 'reports/release-readiness/accepted-preview.json'), 'utf8'));
  if (evidence.ok !== true || evidence.releaseId !== manifest.releaseId || evidence.sourceDigest !== manifest.sourceDigest || evidence.authenticatedIdentityAssertionLiveVerified !== true || !Array.isArray(evidence.checks) || evidence.checks.length < 12 || evidence.checks.some(check => check.ok !== true)) {
    throw new Error('Stable staging promotion requires accepted live preview evidence for this exact source');
  }
}
const result = { project, branch, stagingRoot, manifest };
const descriptor = resolve(root, promote ? 'reports/release-readiness/latest-staging-package.json' : 'reports/release-readiness/latest-pages-package.json');
mkdirSync(dirname(descriptor), { recursive: true });
writeFileSync(descriptor, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--deploy')) {
  const cli = process.env.WRANGLER_CLI;
  if (!cli || !existsSync(cli)) throw new Error('Set WRANGLER_CLI to an installed wrangler/bin/wrangler.js');
  const deployment = spawnSync(process.execPath, [cli, 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, '--commit-hash', manifest.baseCommit, `--commit-dirty=${Boolean(manifest.dirty)}`], {
    cwd: stagingRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (deployment.error) throw deployment.error;
  process.exitCode = deployment.status ?? 1;
}
