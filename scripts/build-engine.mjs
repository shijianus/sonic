import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeArtifactReceipt } from './release-artifacts.mjs';
import { validateReleaseManifest } from './release-inputs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist-server');
const [mode, ...unexpected] = process.argv.slice(2);
if (unexpected.length || (mode !== undefined && mode !== '--partial-docker-stage')) {
  throw new Error('Usage: npm run build:engine [-- --partial-docker-stage]');
}

// Docker supplies the frontend stage's identity, which the caller has checked
// against the full source tree before building the image. Local builds derive
// and verify that identity from the complete checkout or source archive.
const partial = mode === '--partial-docker-stage';
const manifest = JSON.parse(partial
  ? readFileSync(resolve(root, 'dist/release.json'), 'utf8')
  : execFileSync(process.execPath, ['scripts/write-release-manifest.mjs', '--output', 'dist/release.json', '--print'], {
    cwd: root, encoding: 'utf8',
  }));
const unversionedDocker = partial && manifest.baseCommit === 'unknown' && manifest.sourceDigest === 'unknown';
const release = unversionedDocker ? null : validateReleaseManifest(manifest, { allowUnknownCommit: true });
const compiled = release ? { ...release, engineIdentityCompiled: true } : null;

const receipt = resolve(dist, '.sonic-build.json');
rmSync(receipt, { force: true });
mkdirSync(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: resolve(dist, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { SONIC_COMPILED_ENGINE_RELEASE: JSON.stringify(compiled) },
});
if (release) writeArtifactReceipt(dist, 'engine', release);
