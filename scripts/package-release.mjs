import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyReleaseInputs, createReleaseFileIndex, verifyRelease } from './release-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verified = verifyRelease(root, { manifestPath: 'dist/release.json' });
const { manifest } = verified;
const fileIndex = createReleaseFileIndex(manifest, verified);
const output = join(root, 'reports/release-readiness/artifacts');
const archive = join(output, `sonic-${manifest.releaseId}.tar.gz`);
if (existsSync(archive) || existsSync(`${archive}.sha256`)) throw new Error('Release archive already exists; refusing overwrite');
const staging = mkdtempSync(join(tmpdir(), `sonic-bundle-${manifest.releaseId}-`));
try {
  // Copy only files whose exact paths/bytes were hashed; never copy whole trees.
  copyReleaseInputs(root, staging, verified.files);
  writeFileSync(join(staging, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(staging, 'release-files.json'), JSON.stringify(fileIndex, null, 2) + '\n');
  verifyRelease(staging, { manifestPath: 'release.json', indexPath: 'release-files.json' });
  // Catch concurrent edits between the initial digest, copy and final archive.
  verifyRelease(root, { manifestPath: 'dist/release.json' });
  mkdirSync(output, { recursive: true });
  const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
  execFileSync(tar, ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${sha256}  sonic-${manifest.releaseId}.tar.gz\n`, { flag: 'wx' });
  const descriptor = { manifest, archive, sha256, staging, entries: readdirSync(staging), fileIndex: 'release-files.json', fileCount: verified.files.length };
  writeFileSync(join(root, 'reports/release-readiness/latest-release-package.json'), JSON.stringify(descriptor, null, 2) + '\n');
  console.log(JSON.stringify(descriptor, null, 2));
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
