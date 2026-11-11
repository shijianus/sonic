import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildPagesDeploymentTree } from './pages-release-lib.mjs'

let stagingRoot
try {
  const deployment = buildPagesDeploymentTree(process.cwd())
  stagingRoot = deployment.stagingRoot
  const { manifest, pagesArtifactDigest } = deployment
  const compiled = readFileSync(join(stagingRoot, 'functions/_lib/sonic/compiled-release.ts'), 'utf8')
  const match = compiled.match(/export const COMPILED_RELEASE\s*=\s*(\{[\s\S]*\});\s*$/)
  if (!match) throw new Error('compiled release identity is missing or malformed')
  let compiledIdentity
  try {
    compiledIdentity = JSON.parse(match[1])
  } catch {
    throw new Error('compiled release identity is not valid JSON')
  }
  for (const [key, value] of Object.entries({
    baseCommit: manifest.baseCommit,
    sourceDigest: manifest.sourceDigest,
    releaseId: manifest.releaseId,
    buildTime: manifest.buildTime,
    dirty: manifest.dirty,
    pagesArtifactDigest,
  })) {
    if (compiledIdentity[key] !== value) {
      throw new Error(`compiled release identity mismatch for ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(compiledIdentity[key])}`)
    }
  }
  const release = JSON.parse(readFileSync(join(stagingRoot, 'dist/release.json'), 'utf8'))
  if (JSON.stringify(release) !== JSON.stringify(manifest)) throw new Error('dist/release.json differs from verified manifest')
  console.log(JSON.stringify({
    ok: true,
    stagingRoot,
    releaseId: manifest.releaseId,
    sourceDigest: manifest.sourceDigest,
    pagesArtifactDigest,
    compiledRelease: true,
  }))
} catch (error) {
  console.error(`[verify:pages-deploy] ${error.message}`)
  process.exitCode = 1
} finally {
  if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true })
}
