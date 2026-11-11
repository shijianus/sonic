import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReleaseManifest } from './release-inputs.mjs';

const receiptFile = '.sonic-build.json';
const entryFiles = { frontend: 'index.html', engine: 'index.mjs' };
const identityFields = ['schemaVersion', 'baseCommit', 'sourceDigest', 'releaseId', 'buildTime', 'dirty'];

function regularFile(path, stat = lstatSync(path)) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Invalid build artifact file: ${path}`);
}

function outputDigest(directory, kind) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`Invalid build output directory: ${directory}`);
  regularFile(join(directory, entryFiles[kind]));
  const hash = createHash('sha256');
  function walk(path, prefix = '') {
    for (const name of readdirSync(path).sort()) {
      if (!prefix && name === receiptFile) continue;
      const file = join(path, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, `${relative}/`);
      else {
        regularFile(file, stat);
        const contentHash = createHash('sha256').update(readFileSync(file)).digest('hex');
        hash.update(`${JSON.stringify([relative, contentHash])}\n`);
      }
    }
  }
  walk(directory);
  return hash.digest('hex');
}

export function writeArtifactReceipt(directory, kind, manifest) {
  const release = validateReleaseManifest(manifest, { allowUnknownCommit: true });
  const receipt = { kind, release, sha256: outputDigest(directory, kind) };
  writeFileSync(join(directory, receiptFile), `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
}

function verifyArtifactReceipt(directory, kind, manifest) {
  const path = join(directory, receiptFile);
  let receipt;
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid output directory');
    regularFile(path);
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Missing or invalid ${kind} build receipt; run npm run build and npm run build:engine`, { cause });
  }
  if (receipt?.kind !== kind || identityFields.some(field => receipt.release?.[field] !== manifest[field])) {
    throw new Error(`${kind} build receipt does not match dist/release.json`);
  }
  if (receipt.sha256 !== outputDigest(directory, kind)) throw new Error(`${kind} build output checksum mismatch`);
}

export function verifyEngineArtifacts(root, manifest) {
  verifyArtifactReceipt(join(root, 'dist'), 'frontend', manifest);
  verifyArtifactReceipt(join(root, 'dist-server'), 'engine', manifest);
}
