import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSuppliedDigest, collectReleaseInputs, RELEASE_DIRECTORIES,
  REQUIRED_RELEASE_FILES, validateReleaseManifest, verifyRelease,
} from './release-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outputName = 'player/dist/release.json';
let printOnly = false;
let digestOnly = false;
let partialDockerStage = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) outputName = args[++i];
  else if (args[i] === '--print') printOnly = true;
  else if (args[i] === '--digest') digestOnly = true;
  else if (args[i] === '--partial-docker-stage') partialDockerStage = true;
  else throw new Error(`Unknown or incomplete manifest argument: ${args[i]}`);
}
if (digestOnly && partialDockerStage) throw new Error('Cannot compute a full source digest in a partial Docker stage');
const output = resolve(root, outputName);
let inputs;
let sourceDigest;
if (partialDockerStage) {
  // The frontend stage only contains player/ and these helpers. Never compare
  // its subset hash to the full release, or silently describe it as verified.
  sourceDigest = String(process.env.SONIC_SOURCE_DIGEST || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)
    || !/^[a-f0-9]{40}$/i.test(process.env.SONIC_RELEASE_COMMIT || '')
    || !/^[a-zA-Z0-9._-]{7,128}$/.test(process.env.SONIC_RELEASE_ID || '')
    || !Number.isFinite(Date.parse(process.env.SONIC_BUILD_TIME || ''))
    || !/^(?:0|1|true|false)$/i.test(process.env.SONIC_RELEASE_DIRTY || '')) {
    throw new Error('Partial Docker stage requires all five explicit release metadata values');
  }
  console.error('[release] Partial Docker stage: supplied identity only; full-source verification must run on the checkout/extracted archive before docker build');
} else {
  inputs = collectReleaseInputs(root);
  sourceDigest = inputs.sourceDigest;
  // Even --digest is fail-closed when a caller supplies a stale digest.
  assertSuppliedDigest(sourceDigest);
  if (digestOnly) {
    console.log(sourceDigest);
    process.exit(0);
  }
}
function git(...gitArgs) {
  try { return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
// An extracted release has no .git. Preserve its verified original identity on
// npm run build rather than relabelling it "unknown" or with a new build time.
const archived = !partialDockerStage && existsSync(resolve(root, 'release.json'))
  ? verifyRelease(root, { manifestPath: 'release.json', indexPath: 'release-files.json' }).manifest : null;
if (archived) {
  for (const [key, value] of Object.entries({
    SONIC_RELEASE_COMMIT: archived.baseCommit, SONIC_RELEASE_ID: archived.releaseId,
    SONIC_BUILD_TIME: archived.buildTime, SONIC_RELEASE_DIRTY: String(archived.dirty),
  })) {
    const supplied = process.env[key];
    const normalized = key === 'SONIC_RELEASE_DIRTY' && /^(?:0|1|true|false)$/i.test(supplied || '')
      ? String(/^(?:1|true)$/i.test(supplied)) : supplied;
    if (supplied && normalized !== value) throw new Error(`${key} conflicts with the verified archive manifest`);
  }
}
const baseCommit = String(process.env.SONIC_RELEASE_COMMIT || archived?.baseCommit || git('rev-parse', 'HEAD') || 'unknown').trim();
const gitDirty = !partialDockerStage && git('status', '--porcelain', '--untracked-files=normal', '--', ...RELEASE_DIRECTORIES, ...REQUIRED_RELEASE_FILES) !== '';
const dirtyValue = process.env.SONIC_RELEASE_DIRTY;
if (dirtyValue !== undefined && dirtyValue !== '' && !/^(?:0|1|true|false)$/i.test(dirtyValue)) throw new Error('SONIC_RELEASE_DIRTY must be true/false or 1/0');
const dirty = dirtyValue === undefined || dirtyValue === '' ? (archived?.dirty ?? gitDirty) : /^(?:1|true)$/i.test(dirtyValue);
const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null;
const stableExisting = existing?.sourceDigest === sourceDigest && existing?.baseCommit === baseCommit && existing?.dirty === dirty;
const commitTime = !partialDockerStage && !dirty && baseCommit !== 'unknown' ? git('show', '-s', '--format=%cI', baseCommit) : '';
const buildTime = String(process.env.SONIC_BUILD_TIME || archived?.buildTime || (stableExisting ? existing.buildTime : '') ||
  (commitTime ? new Date(commitTime).toISOString() : new Date().toISOString()));
const releaseId = String(process.env.SONIC_RELEASE_ID || archived?.releaseId || (dirty || baseCommit === 'unknown' ? `${baseCommit.slice(0, 12)}-${sourceDigest.slice(0, 12)}` : baseCommit));
const manifest = validateReleaseManifest({ schemaVersion: 1, baseCommit, sourceDigest, releaseId, buildTime, dirty }, { allowUnknownCommit: true });
if (!printOnly) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify(manifest, null, 2));
