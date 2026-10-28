#!/usr/bin/env node
// Generate a CycloneDX-style inventory of production player dependencies from pnpm.
// The engine bundle ships no third-party npm runtime dependencies (only Node built-ins).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputPath = path.resolve(process.argv[2] || 'reports/sbom/sonic-player.cdx.json');

const pnpmArgs = ['--dir', 'player', 'licenses', 'list', '--prod', '--json'];
const result =
  process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `pnpm ${pnpmArgs.join(' ')}`], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
      })
    : spawnSync('pnpm', pnpmArgs, {
        cwd: root,
        encoding: 'utf8',
        shell: false,
      });
if (result.error) {
  console.error(`[sbom] unable to run pnpm: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[sbom] pnpm licenses failed (${result.status}): ${result.stderr?.slice(0, 400)}`);
  process.exit(1);
}

let grouped;
try {
  grouped = JSON.parse(result.stdout);
} catch (error) {
  console.error(`[sbom] invalid pnpm JSON output: ${error?.message}`);
  process.exit(1);
}

const components = [];
const licenseCounts = {};
const spdxLike = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
]);
for (const [license, packages] of Object.entries(grouped)) {
  for (const pkg of packages) {
    for (const version of pkg.versions || []) {
      const purlName = pkg.name.startsWith('@')
        ? `%40${pkg.name.slice(1)}`
        : encodeURIComponent(pkg.name);
      const purl = `pkg:npm/${purlName}@${version}`;
      components.push({
        type: 'library',
        'bom-ref': purl,
        name: pkg.name,
        version,
        licenses: [spdxLike.has(license) ? { license: { id: license } } : { license: { name: license } }],
        purl,
        ...(pkg.homepage ? { externalReferences: [{ type: 'website', url: pkg.homepage }] } : {}),
      });
      licenseCounts[license] = (licenseCounts[license] || 0) + 1;
    }
  }
}
components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const permissive = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
]);
const review = Object.keys(licenseCounts).filter((license) => !permissive.has(license));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Sonic', name: 'generate-sbom.mjs', version: '1.0.0' }],
    component: {
      type: 'application',
      name: 'sonic-music-player',
      version: JSON.parse(fs.readFileSync(path.join(root, 'player/package.json'), 'utf8')).version,
      licenses: [{ license: { id: 'MIT' } }],
    },
  },
  components,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`);

console.log(
  JSON.stringify({
    ok: true,
    output: path.relative(root, outputPath),
    components: components.length,
    licenseCounts,
    reviewLicenses: review,
  }),
);
if (review.length > 0) {
  console.warn(
    `[sbom] licenses requiring manual review: ${review.join(', ')} (not automatically a violation)`,
  );
}
