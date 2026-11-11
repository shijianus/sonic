import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { buildPagesDeploymentTree } from './pages-release-lib.mjs'

const project = process.env.CF_PAGES_PROJECT || 'cfsolara'
const branch = process.env.CF_PAGES_BRANCH || 'main'
const allowDirty = process.env.ALLOW_DIRTY_DEPLOY === '1'

if (project === 'sonic-staging') {
  console.error('[deploy] sonic-staging must use scripts/prepare-pages-preview.mjs with explicit promotion.')
  process.exit(1)
}
if (!/^[a-z0-9-]{1,63}$/.test(project) || !branch || !/^[a-zA-Z0-9._/-]{1,128}$/.test(branch)) {
  console.error('[deploy] invalid project or branch name')
  process.exit(1)
}

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
if (dirtyEntries && allowDirty) {
  console.warn('[deploy] ⚠ ALLOW_DIRTY_DEPLOY=1: deploying with uncommitted changes')
  console.warn(dirtyEntries)
}

let deployment
try {
  deployment = buildPagesDeploymentTree(process.cwd())
} catch (error) {
  console.error(`[deploy] release verification failed: ${error.message}`)
  process.exit(1)
}
const { stagingRoot, manifest } = deployment
if (!/^[a-f0-9]{40}$/i.test(manifest.baseCommit)) {
  console.error('[deploy] release manifest does not contain a real base commit; refusing to deploy')
  process.exit(1)
}
if (!manifest.buildTime || !Number.isFinite(Date.parse(manifest.buildTime))) {
  console.error('[deploy] release manifest does not contain a valid build time; refusing to deploy')
  process.exit(1)
}
if (manifest.dirty && !allowDirty) {
  console.error('[deploy] release manifest is dirty; rebuild from a clean commit or set ALLOW_DIRTY_DEPLOY=1 for a reviewed emergency deploy')
  process.exit(1)
}

// Production deploys must state the browser access policy explicitly. Cloudflare
// Pages cannot distinguish a non-main production branch from a preview branch at
// runtime, so missing values now fail closed at the edge; fail here first.
const deployEnvironment = String(process.env.SONIC_DEPLOY_ENV || 'production').trim().toLowerCase()
if (!['production', 'preview'].includes(deployEnvironment)) {
  console.error('[deploy] SONIC_DEPLOY_ENV must be production or preview')
  process.exit(1)
}
if (deployEnvironment === 'production') {
  const sonicEnv = String(process.env.SONIC_ENV || '').trim().toLowerCase()
  const accessMode = String(process.env.SONIC_ACCESS_MODE || '').trim().toLowerCase()
  const contentPolicy = String(process.env.SONIC_CONTENT_POLICY || 'strict-allowlist').trim().toLowerCase()
  const allowedSources = String(process.env.SONIC_ALLOWED_SOURCES || 'netease,qq,kugou,kuwo,amll,lrclib').trim()
  const runtime = String(process.env.SONIC_RUNTIME || '').trim().toLowerCase()
  if (sonicEnv !== 'production') {
    console.error('[deploy] SONIC_ENV=production is required for a production deploy')
    process.exit(1)
  }
  if (accessMode !== 'open' && accessMode !== 'invite') {
    console.error('[deploy] SONIC_ACCESS_MODE must be explicitly open or invite for a production deploy')
    process.exit(1)
  }
  if (runtime === 'linux-engine') {
    console.error('[deploy] SONIC_RUNTIME=linux-engine is invalid for a Pages project; remove it from the Pages environment')
    process.exit(1)
  }
  if (!['strict', 'strict-allowlist', 'allowlist', 'controlled-beta'].includes(contentPolicy)) {
    console.error('[deploy] SONIC_CONTENT_POLICY=strict-allowlist is required for a production deploy')
    process.exit(1)
  }
  if (!allowedSources) {
    console.error('[deploy] SONIC_ALLOWED_SOURCES must list only written-off approved sources for a production deploy')
    process.exit(1)
  }
}

// A deployment is not verified until the live site is read back. Production
// deploys require an explicit URL unless the operator acknowledges the gap.
const verifyUrl = String(process.env.SONIC_DEPLOY_VERIFY_URL || '').trim()
const allowUnverified = process.env.ALLOW_UNVERIFIED_DEPLOY === '1'
if (deployEnvironment === 'production' && !verifyUrl && !allowUnverified) {
  console.error('[deploy] SONIC_DEPLOY_VERIFY_URL is required to verify the live release after deployment')
  console.error('[deploy] Set ALLOW_UNVERIFIED_DEPLOY=1 only for an explicitly reviewed emergency deploy.')
  process.exit(1)
}
if (verifyUrl && !String(process.env.SONIC_ENGINE_SECRET || '').trim()) {
  console.error('[deploy] SONIC_ENGINE_SECRET is required to verify the protected health endpoint')
  process.exit(1)
}

const wranglerCli = process.env.WRANGLER_CLI
const wranglerBin = process.env.WRANGLER_BIN || 'npx'
const command = wranglerCli ? process.execPath : wranglerBin
// wrangler is pinned in devDependencies. --no-install prevents a deploy from
// silently fetching a different router/runtime version at release time.
const wranglerPrefix = wranglerCli
  ? [wranglerCli]
  : wranglerBin === 'npx'
    ? ['--no-install', 'wrangler']
    : [];
const args = [
  ...wranglerPrefix,
  'pages',
  'deploy',
  'dist',
  '--project-name',
  project,
  '--branch',
  branch,
  '--commit-hash',
  manifest.baseCommit,
  `--commit-dirty=${Boolean(manifest.dirty)}`,
]

console.log(`[deploy] project=${project} branch=${branch} release=${manifest.releaseId} source=${manifest.sourceDigest}`)
console.log(`[deploy] staged tree=${stagingRoot}`)

const result = spawnSync(command, args, {
  cwd: stagingRoot,
  env: process.env,
  stdio: 'inherit',
  shell: !wranglerCli && process.platform === 'win32',
})

try {
  if (result.error) {
    console.error(`[deploy] failed to start ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)

  if (verifyUrl) {
    const verified = spawnSync(process.execPath, ['scripts/verify-deployed-release.mjs', verifyUrl], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    if (verified.status !== 0) {
      console.error('[deploy] the deployment is live but failed post-deploy verification; roll back immediately')
      process.exit(1)
    }
  } else {
    console.warn('[deploy] ⚠ ALLOW_UNVERIFIED_DEPLOY=1: post-deploy verification skipped')
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}
process.exit(0)
