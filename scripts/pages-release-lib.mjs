// Build an isolated Pages deployment tree whose functions carry the exact
// release identity that was verified from dist/release.json.
import { cpSync, existsSync, lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyReleaseInputs, excludedReleasePath, verifyRelease } from './release-inputs.mjs';

export function buildPagesDeploymentTree(root, { manifestPath = 'dist/release.json' } = {}) {
  root = resolve(root);
  const absoluteManifest = resolve(root, manifestPath);
  if (!existsSync(absoluteManifest)) throw new Error('Build the release first: npm run build');
  const verified = verifyRelease(root, { manifestPath });
  const { manifest } = verified;
  const stagingRoot = mkdtempSync(join(tmpdir(), 'sonic-pages-deploy-'));
  copyReleaseInputs(
    root,
    stagingRoot,
    verified.files.filter(file =>
      file.path.startsWith('functions/') ||
      ['package.json', 'package-lock.json', 'tsconfig.json'].includes(file.path)
    ),
  );
  cpSync(resolve(root, 'dist'), join(stagingRoot, 'dist'), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: path => {
      const name = path.slice(resolve(root, 'dist').length + 1).replaceAll('\\', '/');
      // Vite's .js.gz/.css.gz files are build output, not source archives.
      if (excludedReleasePath(name.replace(/\.gz$/i, ''))) return false;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        throw new Error(`Link not allowed in Pages output: ${name}`);
      }
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
  return { stagingRoot, manifest, verified };
}
