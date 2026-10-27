import { spawnSync } from 'node:child_process'

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

const wranglerBin = process.env.WRANGLER_BIN || 'npx'
const wranglerArgs = wranglerBin === 'npx'
  ? ['wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, `--commit-dirty=${allowDirty ? 'true' : 'false'}`]
  : ['pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, `--commit-dirty=${allowDirty ? 'true' : 'false'}`]

const result = spawnSync(wranglerBin, wranglerArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error(`[deploy] failed to start ${wranglerBin}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
