import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const project = process.env.CF_PAGES_PROJECT || 'cfsolara'
const branch = process.env.CF_PAGES_BRANCH || 'main'
const allowDirty = process.env.ALLOW_DIRTY_DEPLOY === '1'

// Deployment integrity gate: refuse to publish an unreviewed working tree.
// Set ALLOW_DIRTY_DEPLOY=1 only for an explicitly reviewed emergency deploy.
const gitStatus = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
if (gitStatus.error) {
  console.error(`[deploy] unable to inspect working tree: ${gitStatus.error.message}`)
  process.exit(1)
}
if (gitStatus.status !== 0) {
  console.error('[deploy] git status failed; refusing to deploy an unverifiable tree')
  process.exit(1)
}
const dirtyEntries = gitStatus.stdout.trim()
if (dirtyEntries && !allowDirty) {
  console.error('[deploy] working tree has uncommitted changes; commit or stash them first.')
  console.error('[deploy] Set ALLOW_DIRTY_DEPLOY=1 only for an explicitly reviewed deploy.')
  console.error(dirtyEntries)
  process.exit(1)
}

const compiledPath = resolve('functions/_lib/sonic/compiled-release.ts')
let originalCompiledContent = null
const releaseManifestPath = resolve('dist/release.json')

if (existsSync(compiledPath) && existsSync(releaseManifestPath)) {
  try {
    originalCompiledContent = readFileSync(compiledPath, 'utf8')
    const manifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'))
    const identity = {
      baseCommit: manifest.baseCommit || 'unknown',
      sourceDigest: manifest.sourceDigest || '',
      releaseId: manifest.releaseId || '',
      buildTime: manifest.buildTime || new Date().toISOString(),
      dirty: false,
    }
    writeFileSync(compiledPath, `export interface CompiledRelease {\n  baseCommit: string;\n  sourceDigest: string;\n  releaseId: string;\n  buildTime: string;\n  dirty: boolean;\n}\n\nexport const COMPILED_RELEASE: CompiledRelease | null = ${JSON.stringify(identity, null, 2)};\n`)
    console.log(`[deploy] Injected release identity (${identity.releaseId}) into ${compiledPath}`)
  } catch (err) {
    console.warn(`[deploy] Warning: Failed to inject compiled release identity: ${err.message}`)
  }
}

const wranglerBin = process.env.WRANGLER_BIN || 'npx'
const wranglerArgs = wranglerBin === 'npx'
  ? ['wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, `--commit-dirty=true`]
  : ['pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, `--commit-dirty=true`]

let result
try {
  result = spawnSync(wranglerBin, wranglerArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
} finally {
  if (originalCompiledContent !== null) {
    try {
      writeFileSync(compiledPath, originalCompiledContent)
      console.log(`[deploy] Restored ${compiledPath}`)
    } catch (e) {
      console.error(`[deploy] Failed to restore ${compiledPath}: ${e.message}`)
    }
  }
}

if (result.error) {
  console.error(`[deploy] failed to start ${wranglerBin}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)

