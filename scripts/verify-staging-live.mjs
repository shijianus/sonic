import { spawn } from 'node:child_process';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { durablePagesInviteNamespace, durablePagesInviteReady, strictEdgeRateLimitReady } from './pages-release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectName = process.env.CF_PAGES_PROJECT || 'sonic-staging';
const envPath = process.env.SONIC_STAGING_ENV_PATH || '';
const remoteEnvPath = process.env.SONIC_STAGING_REMOTE_ENV_PATH || '';
const remoteIdentityPath = process.env.SONIC_STAGING_REMOTE_IDENTITY_PATH || '';
const sshTarget = process.env.SONIC_STAGING_SSH_TARGET || '';
const sshPort = process.env.SONIC_STAGING_SSH_PORT || '22';
const sshArgs = ['-T', '-p', sshPort, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', sshTarget, 'python3', '-'];
const protectedInviteProbe = '/api/music/search?q=Sonic&source=synthetic&count=1';
const inviteCookieName = '__Host-sonic_access';
const checks = [];
class SafeError extends Error {}
function ensure(value, code) { if (!value) throw new SafeError(code); }
function passed(name) { checks.push({ name, ok: true }); }
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new SafeError('LOCAL_JSON_UNAVAILABLE_OR_INVALID'); }
}
function validateManifest(manifest) {
  ensure(/^[a-f0-9]{40}$/i.test(manifest.baseCommit), 'INVALID_MANIFEST_COMMIT');
  ensure(/^[a-f0-9]{64}$/i.test(manifest.sourceDigest), 'INVALID_MANIFEST_DIGEST');
  ensure(/^[a-z0-9][a-z0-9._-]{6,127}$/i.test(manifest.releaseId), 'INVALID_MANIFEST_RELEASE');
  ensure(Number.isFinite(Date.parse(manifest.buildTime)) && typeof manifest.dirty === 'boolean', 'INVALID_MANIFEST_METADATA');
}
function httpsUrl(raw, code) {
  let url;
  try { url = new URL(raw); } catch { throw new SafeError(code); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, code);
  return url;
}
function previewUrl(raw) {
  const url = httpsUrl(raw, 'INVALID_PREVIEW_URL');
  ensure(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sonic-staging\.pages\.dev$/.test(url.hostname), 'INVALID_PREVIEW_HOST');
  ensure(!url.port && url.pathname === '/', 'INVALID_PREVIEW_PATH');
  return url.origin;
}
async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  } catch { throw new SafeError('HTTP_NETWORK_OR_TIMEOUT'); }
}
async function bytes(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      ensure(size <= limit, 'HTTP_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof SafeError ? error : new SafeError('HTTP_BODY_FAILED');
  }
}
async function json(response) {
  const body = await bytes(response);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new SafeError('HTTP_JSON_INVALID'); }
}
async function discard(response) { await response.body?.cancel().catch(() => {}); }
async function cloudflare(path) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  ensure(Boolean(token), 'EXISTING_CLOUDFLARE_AUTH_MISSING');
  const response = await request(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
  ensure(response.ok, 'CLOUDFLARE_READ_DENIED');
  const body = await json(response);
  ensure(body.success === true, 'CLOUDFLARE_READ_FAILED');
  return body.result;
}
async function projectMetadata(stable = false) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  ensure(/^[a-f0-9]{32}$/i.test(account || ''), 'EXISTING_CLOUDFLARE_ACCOUNT_MISSING');
  ensure(!process.env.CF_PAGES_PROJECT || process.env.CF_PAGES_PROJECT === projectName, 'STAGING_PROJECT_REQUIRED');
  const apiPath = `/accounts/${account}/pages/projects/${projectName}`;
  const project = await cloudflare(apiPath);
  ensure(project.name === projectName && project.production_branch === 'staging', 'STAGING_PROJECT_CONFIGURATION_CHANGED');
  const preview = project.deployment_configs?.preview;
  const production = project.deployment_configs?.production;
  ensure(preview && production, 'STAGING_ENVIRONMENTS_MISSING');
  const selected = stable ? production : preview;
  const variables = selected.env_vars || {};
  const stagingRateLimitNamespaceId = selected.durable_object_namespaces?.SONIC_RATE_LIMIT_BUCKETS?.namespace_id;
  const accessModeBinding = variables.SONIC_ACCESS_MODE;
  ensure(!accessModeBinding || accessModeBinding.type === 'plain_text', 'STAGING_ACCESS_MODE_UNVERIFIABLE');
  const declaredAccessMode = String(accessModeBinding?.value || '').trim().toLowerCase();
  ensure(['', 'open', 'legacy-staging', 'invite'].includes(declaredAccessMode), 'STAGING_ACCESS_MODE_INVALID');
  const accessGateMode = declaredAccessMode === 'invite' ? 'invite' : 'legacy-staging';
  const stagingAccessNamespaceId = durablePagesInviteNamespace(selected);
  const otherAccessNamespaceId = (stable ? preview : production).durable_object_namespaces?.SONIC_ACCESS_BUCKETS?.namespace_id;
  const inviteGateBlockers = accessGateMode !== 'invite' ? ['STAGING_PRODUCT_INVITE_MODE_REQUIRED'] :
    !stagingAccessNamespaceId ? ['STAGING_DURABLE_INVITE_BINDING_REQUIRED'] :
    stagingAccessNamespaceId === otherAccessNamespaceId ? ['STAGING_INVITE_NAMESPACE_NOT_ISOLATED'] : [];
  const durableSelected = Boolean(selected.durable_object_namespaces?.SONIC_ACCESS_BUCKETS || variables.SONIC_REQUIRE_DURABLE_INVITES);
  const accessBindings = accessGateMode === 'invite'
    ? ['SONIC_INVITE_CODES', ...(durableSelected ? [] : ['SONIC_ACCESS_SECRET'])]
    : ['SONIC_STAGING_ACCESS_TOKEN'];
  for (const name of [...accessBindings, 'SONIC_ENGINE_SECRET', 'SONIC_SECRET']) {
    ensure(variables[name]?.type === 'secret_text', 'EXISTING_PREVIEW_SECRET_BINDING_MISSING');
  }
  ensure(['staging', 'preview'].includes(variables.SONIC_ENV?.value), 'PREVIEW_ENVIRONMENT_REQUIRED');
  ensure(/^(1|true|yes|on)$/i.test(variables.SONIC_ENABLE_LOCAL_ENGINE?.value || ''), 'PREVIEW_ENGINE_DISABLED');
  const engine = httpsUrl(variables.SONIC_LOCAL_ENGINE_URL?.value, 'INVALID_STAGING_ENGINE_URL');
  ensure(engine.toString() === httpsUrl(production.env_vars?.SONIC_LOCAL_ENGINE_URL?.value, 'INVALID_EXISTING_ENGINE_URL').toString(), 'STAGING_ENGINE_URL_PARITY_FAILED');
  const names = Object.keys(variables).sort();
  const existingNames = Object.keys(production.env_vars || {}).sort();
  const allNames = [...new Set([...names, ...existingNames])].sort();
  const metadata = {
    accountId: account,
    project: projectName,
    productionBranch: project.production_branch,
    publicStagingUrl: 'https://sonic-staging.pages.dev',
    engineUrl: engine.toString().replace(/\/$/, ''),
    accessGateMode,
    stagingAccessNamespaceId,
    inviteGateBlockers,
    stagingRateLimitNamespaceId,
    variableNamesEqual: JSON.stringify(names) === JSON.stringify(existingNames),
    variableBindings: Object.fromEntries(allNames.map(name => [name, {
      previewType: variables[name]?.type || null,
      stagingType: production.env_vars?.[name]?.type || null,
      ...(variables[name]?.type === 'plain_text' && production.env_vars?.[name]?.type === 'plain_text'
        ? { equal: variables[name].value === production.env_vars[name].value } : {}),
    }])),
    previewCompatibilityDate: preview.compatibility_date,
    stagingCompatibilityDate: production.compatibility_date,
    previewCompatibilityFlags: preview.compatibility_flags || [],
    stagingCompatibilityFlags: production.compatibility_flags || [],
    independentIdentityBindingPresent: Boolean(variables.SONIC_ENGINE_IDENTITY_SECRET),
    previewUserSigningSecretEqualsEngine: null,
    userSigningComparisonReason: 'Cloudflare masks existing secret_text values; no credentials were minted to compare them',
  };
  passed('existing staging project and preview bindings inspected without changes');
  return { apiPath, metadata };
}
async function credentials(accessGateMode) {
  ensure(sshTarget, 'SONIC_STAGING_SSH_TARGET_REQUIRED');
  ensure(remoteEnvPath, 'SONIC_STAGING_REMOTE_ENV_PATH_REQUIRED');
  ensure(remoteIdentityPath, 'SONIC_STAGING_REMOTE_IDENTITY_PATH_REQUIRED');
  const remoteDataDir = process.env.SONIC_STAGING_REMOTE_DATA_DIR || '';
  ensure(remoteDataDir, 'SONIC_STAGING_REMOTE_DATA_DIR_REQUIRED');
  const requiredKeys = ['SONIC_ENGINE_SECRET', 'SONIC_SECRET'];
  if (accessGateMode === 'legacy-staging') requiredKeys.push('SONIC_STAGING_ACCESS_TOKEN');
  // Only this captured pipe contains values; never inherit SSH stdout/stderr or write it to a file.
  const source = String.raw`
import json,pathlib,re,shlex,stat,subprocess
try
 p=pathlib.Path(${JSON.stringify(remoteEnvPath)})
 data_dir=${JSON.stringify(remoteDataDir)}
 if not p.is_file() or stat.S_IMODE(p.stat().st_mode)!=0o600:raise ValueError()
 values={}
 for raw in p.read_text().splitlines():
  line=raw.strip()
  if not line or line.startswith('#'):continue
  if line.startswith('export '):line=line[7:].lstrip()
  key,sep,value=line.partition('=')
  if sep:values[key.strip()]=' '.join(shlex.split(value,comments=True,posix=True))
 process=subprocess.run(['docker','inspect','sonic-staging-engine'],capture_output=True,text=True,timeout=15)
 if process.returncode:raise ValueError()
 container=json.loads(process.stdout)[0]
 if not container['State']['Running']:raise ValueError()
 image=container['Config']['Image']
 immutable=bool(re.fullmatch(r'sha256:[a-f0-9]{64}',image)) and image==container['Image']
 labels=container['Config'].get('Labels') or {}
 if not image.startswith('sonic-staging-engine:') and not (immutable and labels.get('org.opencontainers.image.title')=='Sonic Local Engine'):raise ValueError()
 if not any(m['Source']==data_dir and m['Destination']=='/app/data' for m in container['Mounts']):raise ValueError()
 if container['HostConfig']['PortBindings'].get('8080/tcp')!=[{'HostIp':'127.0.0.1','HostPort':'18080'}]:raise ValueError()
 running=dict(item.split('=',1) for item in container['Config']['Env'] if '=' in item)
 keys=${JSON.stringify(requiredKeys)}
 if not all(values.get(key) and values[key]==running.get(key) for key in keys):raise ValueError()
 if len(values['SONIC_ENGINE_SECRET'])<32 or ('SONIC_STAGING_ACCESS_TOKEN' in keys and len(values['SONIC_STAGING_ACCESS_TOKEN'])<16):raise ValueError()
 identity_path=pathlib.Path(${JSON.stringify(remoteIdentityPath)})
 if identity_path.exists():
  if not identity_path.is_file() or stat.S_IMODE(identity_path.stat().st_mode)!=0o600:raise ValueError()
  identity_lines=identity_path.read_text().splitlines()
  if len(identity_lines)!=1 or not identity_lines[0].startswith('SONIC_ENGINE_IDENTITY_SECRET='):raise ValueError()
  identity=identity_lines[0].split('=',1)[1].strip()
  if len(identity)<32 or identity!=running.get('SONIC_ENGINE_IDENTITY_SECRET') or identity in [values[k] for k in keys]:raise ValueError()
  values['SONIC_ENGINE_IDENTITY_SECRET']=identity
 elif running.get('SONIC_ENGINE_IDENTITY_SECRET'):raise ValueError()
 image_id=container['Image']
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',image_id):raise ValueError()
 print(json.dumps({'ok':True,'imageId':image_id,'credentials':{key:values[key] for key in keys+['SONIC_ENGINE_IDENTITY_SECRET'] if values.get(key)},'presence':{key:bool(values.get(key)) for key in keys+['SONIC_ENGINE_IDENTITY_SECRET']},'savedMatchesRunning':True,'mode':'0600'}))
except Exception:
 print(json.dumps({'ok':False}))
 raise SystemExit(1)
`;
  const result = await new Promise((done, reject) => {
    const sshEnv = { ...process.env };
    delete sshEnv.SONIC_STAGING_TEST_INVITE_CODE;
    const child = spawn('ssh', sshArgs, { env: sshEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', part => {
      output += part;
      if (Buffer.byteLength(output) > 128 * 1024) { tooLarge = true; child.kill(); }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new SafeError('EXISTING_SSH_ACCESS_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) return reject(new SafeError('EXISTING_STAGING_CREDENTIAL_READ_FAILED'));
      try {
        const value = JSON.parse(output);
        ensure(value.ok === true, 'EXISTING_STAGING_CREDENTIAL_READ_FAILED');
        done(value);
      } catch { reject(new SafeError('EXISTING_STAGING_CREDENTIAL_READ_FAILED')); }
      output = '';
    });
    child.stdin.end(source);
  });
  passed('preserved 0600 staging credential file matches the running staging Engine');
  return result;
}
function releaseMatches(release, manifest) {
  return release?.releaseCommit === manifest.baseCommit && release.releaseId === manifest.releaseId &&
    release.sourceDigest === manifest.sourceDigest && release.buildTime === manifest.buildTime && release.dirty === manifest.dirty;
}
function frontendMatches(value, manifest) {
  return ['schemaVersion', 'baseCommit', 'sourceDigest', 'releaseId', 'buildTime', 'dirty'].every(key => value?.[key] === manifest[key]);
}
export async function verifyLegacyAccess(base, secrets, manifest) {
  const headers = { 'X-Sonic-Staging-Token': secrets.SONIC_STAGING_ACCESS_TOKEN };
  let response = await request(`${base}/`);
  ensure(response.status === 401 && /noindex/.test(response.headers.get('x-robots-tag') || ''), 'ANONYMOUS_STAGING_GATE_FAILED');
  ensure((await json(response)).error?.code === 'STAGING_ACCESS_REQUIRED', 'ANONYMOUS_GATE_RESPONSE_INVALID');
  passed('anonymous staging traffic is 401 with noindex');
  response = await request(`${base}/`, { headers });
  ensure(response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || ''), 'EXISTING_STAGING_ACCESS_REJECTED');
  ensure(/noindex/.test(response.headers.get('x-robots-tag') || ''), 'AUTHORIZED_NOINDEX_MISSING');
  if (manifest) ensure(response.headers.get('x-sonic-release') === manifest.releaseId, 'HTML_RELEASE_HEADER_MISMATCH');
  await discard(response);
  passed('existing staging access credential opens HTML with noindex');
  const invitation = new URL(`${base}/`);
  invitation.searchParams.set('staging_token', secrets.SONIC_STAGING_ACCESS_TOKEN);
  response = await request(invitation);
  ensure(response.status === 302 && response.headers.get('location') === '/', 'STAGING_INVITATION_REDIRECT_FAILED');
  const cookie = response.headers.get('set-cookie') || '';
  const correctCookieName = cookie.startsWith('__Host-sonic_staging_access=') || (!manifest && cookie.startsWith('sonic_staging_access='));
  ensure(correctCookieName && /;\s*Path=\/(?:;|$)/i.test(cookie) && !/;\s*Domain=/i.test(cookie) && /;\s*HttpOnly/i.test(cookie) && /;\s*Secure/i.test(cookie) && /;\s*SameSite=Lax/i.test(cookie), 'STAGING_INVITATION_COOKIE_INVALID');
  ensure(response.headers.get('referrer-policy') === 'no-referrer' && /no-store/.test(response.headers.get('cache-control') || ''), 'STAGING_INVITATION_PRIVACY_FAILED');
  await discard(response);
  response = await request(`${base}/`, { headers: { Cookie: cookie.split(';', 1)[0] } });
  ensure(response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || ''), 'STAGING_COOKIE_ACCESS_FAILED');
  if (manifest) ensure(response.headers.get('x-sonic-release') === manifest.releaseId, 'COOKIE_RELEASE_HEADER_MISMATCH');
  await discard(response);
  passed('staging invitation exchanges into a Secure HttpOnly cookie and strips the token URL');
  return headers;
}
function safeInviteCookie(cookie) {
  return /;\s*Path=\/(?:;|$)/i.test(cookie) && !/;\s*Domain=/i.test(cookie) &&
    /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*Secure(?:;|$)/i.test(cookie) && /;\s*SameSite=Lax(?:;|$)/i.test(cookie);
}
async function verifyInviteDenial(base, headers = {}, code = 'STAGING_INVITE_ANONYMOUS_GATE_FAILED') {
  const response = await request(base + protectedInviteProbe, { headers });
  ensure(response.status === 401 && /noindex/.test(response.headers.get('x-robots-tag') || '') &&
    /no-store/.test(response.headers.get('cache-control') || ''), code);
  ensure((await json(response)).error?.code === 'ACCESS_REQUIRED', code);
}
export async function verifyInviteGate(base, manifest) {
  for (const path of ['/', '/invite']) {
    const page = await request(base + path);
    ensure(page.status === 200 && /text\/html/i.test(page.headers.get('content-type') || '') &&
      /noindex/.test(page.headers.get('x-robots-tag') || ''), 'STAGING_INVITE_PAGE_UNAVAILABLE');
    if (manifest) ensure(page.headers.get('x-sonic-release') === manifest.releaseId, 'HTML_RELEASE_HEADER_MISMATCH');
    await discard(page);
  }
  const response = await request(`${base}/api/access/session`);
  ensure(response.status === 401, 'STAGING_INVITE_MODE_UNVERIFIED');
  const session = await json(response);
  ensure(session.mode === 'invite' && session.access === false && session.error?.code === 'ACCESS_REQUIRED', 'STAGING_INVITE_MODE_UNVERIFIED');
  await verifyInviteDenial(base);
  passed('invite entry is reachable with noindex and protected API denies anonymous access');
}
async function closeInviteSession(base, headers) {
  const response = await request(`${base}/api/access/logout`, { method: 'POST', headers: { ...headers, Origin: base } });
  ensure(response.status === 200 && /no-store/.test(response.headers.get('cache-control') || ''), 'STAGING_INVITE_LOGOUT_FAILED');
  const cleared = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${inviteCookieName}=;`));
  ensure(cleared && safeInviteCookie(cleared) && /;\s*Max-Age=0(?:;|$)/i.test(cleared), 'STAGING_INVITE_COOKIE_NOT_CLEARED');
  const logout = await json(response);
  ensure(logout.ok === true && logout.access === false && typeof logout.revocationDurable === 'boolean' &&
    logout.revoked === logout.revocationDurable && logout.serverRevoked === logout.revocationDurable, 'STAGING_INVITE_REVOCATION_FAILED');
  await verifyInviteDenial(base);
  if (logout.revocationDurable) {
    await verifyInviteDenial(base, headers, 'STAGING_INVITE_REVOKED_COOKIE_ACCEPTED');
    passed('durable invite logout revokes the issued session and rejects its replay');
  } else {
    passed('invite logout clears the browser cookie and anonymous access remains blocked');
  }
  return logout.revocationDurable;
}
export async function withInviteAccess(base, code, manifest, verify, { requireDurable = false } = {}) {
  ensure(typeof code === 'string' && code.length >= 16 && code.length <= 256 &&
    !/[\u0000-\u0020\u007f]/.test(code), 'STAGING_TEST_INVITE_CODE_REQUIRED');
  await verifyInviteGate(base, manifest);
  const sessions = new Map();
  function rememberSession(response) {
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${inviteCookieName}=`));
    const pair = cookie?.split(';', 1)[0];
    const headers = pair && /^[A-Za-z0-9_.-]{1,512}$/.test(pair.slice(inviteCookieName.length + 1)) ? { Cookie: pair } : null;
    if (headers) sessions.set(pair, headers);
    return { cookie, headers };
  }
  const redeem = () => request(`${base}/api/access/redeem`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  let result;
  let inviteSessionRevocationDurable;
  let inviteSingleUseLiveVerified = false;
  let failure;
  try {
    let response = await redeem();
    const { cookie, headers } = rememberSession(response);
    ensure(response.status === 200 && /no-store/.test(response.headers.get('cache-control') || '') &&
      response.headers.get('referrer-policy') === 'no-referrer', 'STAGING_INVITE_REDEMPTION_FAILED');
    ensure(headers && safeInviteCookie(cookie) && /;\s*Max-Age=[1-9][0-9]*(?:;|$)/i.test(cookie), 'STAGING_INVITE_COOKIE_INVALID');
    const redemption = await json(response);
    ensure(redemption.ok === true && redemption.access === true && typeof redemption.expiresAt === 'string' &&
      Date.parse(redemption.expiresAt) > Date.now(), 'STAGING_INVITE_REDEMPTION_FAILED');
    response = await request(`${base}/api/access/session`, { headers });
    ensure(response.status === 200 && /no-store/.test(response.headers.get('cache-control') || ''), 'STAGING_INVITE_COOKIE_ACCESS_FAILED');
    const session = await json(response);
    ensure(session.mode === 'invite' && session.access === true && session.expiresAt === redemption.expiresAt, 'STAGING_INVITE_COOKIE_ACCESS_FAILED');
    await verifyInviteDenial(base, { Cookie: `${inviteCookieName}=invalid.signature` }, 'STAGING_INVALID_INVITE_COOKIE_ACCEPTED');
    passed('disposable invite redeems into a secure expiring session and invalid Cookie is rejected');
    if (requireDurable) {
      const repeated = await redeem();
      rememberSession(repeated);
      ensure(repeated.status === 401 && repeated.headers.getSetCookie().length === 0 &&
        (await json(repeated)).error?.code === 'INVITE_INVALID', 'STAGING_INVITE_REDEEMED_TWICE');
      const protectedResult = await request(base + protectedInviteProbe, { headers });
      const cacheControl = protectedResult.headers.get('cache-control') || '';
      ensure(protectedResult.status === 200 && /\bprivate\b/i.test(cacheControl) && /\bno-store\b/i.test(cacheControl),
        'STAGING_PROTECTED_RESPONSE_MUST_NOT_BE_CACHED');
      await discard(protectedResult);
      inviteSingleUseLiveVerified = true;
      passed('consumed invite cannot be redeemed again and protected results are not cacheable');
    }
    result = await verify(headers);
  } catch (error) {
    failure = error;
  } finally {
    for (const headers of sessions.values()) {
      try { inviteSessionRevocationDurable = await closeInviteSession(base, headers); }
      catch (error) { failure ||= error; }
      finally { headers.Cookie = ''; }
    }
    sessions.clear();
  }
  if (failure) throw failure;
  if (requireDurable) ensure(inviteSessionRevocationDurable === true, 'STAGING_DURABLE_INVITE_REVOCATION_REQUIRED');
  return { result, inviteSessionRevocationDurable, inviteSingleUseLiveVerified };
}
async function health(base, secrets) {
  const response = await request(`${base}/api/sonic/engine/health`, { headers: { 'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET } });
  ensure(response.status === 200, 'EXISTING_ENGINE_KEY_OR_READINESS_FAILED');
  const value = await json(response);
  ensure(value.ok === true && value.runtime === 'linux-engine' && value.recommendEngine?.storageKind === 'sqlite', 'STAGING_ENGINE_NOT_DURABLE_OR_READY');
  return value;
}
async function selectDeployment(apiPath, manifest, suppliedUrl, stable = false) {
  if (stable) {
    ensure(!suppliedUrl || suppliedUrl === 'https://sonic-staging.pages.dev', 'STABLE_STAGING_URL_REQUIRED');
    const list = await cloudflare(`${apiPath}/deployments?env=production&per_page=25`);
    const deployment = list.find(item => item.environment === 'production' && item.latest_stage?.status === 'success' && item.deployment_trigger?.metadata?.branch === 'staging' && item.deployment_trigger?.metadata?.commit_hash === manifest.baseCommit);
    ensure(deployment, 'STABLE_STAGING_RELEASE_NOT_DEPLOYED');
    previewUrl(deployment.url);
    passed('Cloudflare confirms the stable staging branch deployment');
    return { base: 'https://sonic-staging.pages.dev', branch: 'staging', branchUrl: 'https://sonic-staging.pages.dev', deploymentId: deployment.id };
  }
  let branch = process.env.CF_PAGES_BRANCH || `rc-${manifest.sourceDigest.slice(0, 12)}`;
  const descriptorPath = resolve(root, 'reports/release-readiness/latest-pages-package.json');
  if (existsSync(descriptorPath)) {
    const descriptor = readJson(descriptorPath);
    ensure(descriptor.project === projectName && frontendMatches(descriptor.manifest, manifest), 'PREVIEW_PACKAGE_MANIFEST_MISMATCH');
    ensure(!process.env.CF_PAGES_BRANCH || descriptor.branch === branch, 'PREVIEW_PACKAGE_BRANCH_MISMATCH');
    branch = descriptor.branch;
  }
  ensure(/^[a-z0-9-]{1,63}$/.test(branch) && branch !== 'staging', 'ISOLATED_PREVIEW_BRANCH_REQUIRED');
  const deployments = await cloudflare(`${apiPath}/deployments?env=preview&per_page=25`);
  const requested = suppliedUrl ? previewUrl(suppliedUrl) : null;
  const deployment = deployments.find(item => item.environment === 'preview' && item.latest_stage?.status === 'success' &&
    item.deployment_trigger?.metadata?.branch === branch && item.deployment_trigger?.metadata?.commit_hash === manifest.baseCommit &&
    (!requested || [item.url, ...(item.aliases || [])].some(raw => previewUrl(raw) === requested)));
  ensure(deployment, 'MATCHING_ISOLATED_PREVIEW_NOT_DEPLOYED');
  const base = previewUrl(deployment.url);
  passed('Cloudflare confirms an isolated preview branch for this manifest and commit');
  return { base, branch, branchUrl: `https://${branch}.sonic-staging.pages.dev`, deploymentId: deployment.id };
}
function contentPolicyEvidence(health) {
  const { ok, mode, allowedSources, effectiveSources } = health.readiness?.contentPolicy || {};
  return { ok, mode, allowedSources, effectiveSources };
}
export async function verifyRelease(base, engine, headers, secrets, manifest) {
  let response = await request(`${base}/release.json`, { headers });
  ensure(response.status === 200 && response.headers.get('x-sonic-release') === manifest.releaseId, 'FRONTEND_RELEASE_RESPONSE_FAILED');
  ensure(frontendMatches(await json(response), manifest), 'FRONTEND_RELEASE_MANIFEST_MISMATCH');
  response = await request(`${base}/api/sonic/engine/health`, { headers: { ...headers, 'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET } });
  ensure(response.status === 200 && response.headers.get('x-sonic-release') === manifest.releaseId, 'EDGE_HEALTH_OR_RELEASE_HEADER_FAILED');
  const edgeHealth = await json(response);
  ensure(edgeHealth.ok === true && edgeHealth.runtime === 'cf-pages' && ['staging', 'preview'].includes(edgeHealth.release?.environment) &&
    releaseMatches(edgeHealth.release, manifest), 'EDGE_RELEASE_IDENTITY_MISMATCH');
  const pagesArtifactDigest = edgeHealth.release?.pagesArtifactDigest;
  ensure(/^[a-f0-9]{64}$/.test(pagesArtifactDigest || ''), 'EDGE_PAGES_ARTIFACT_DIGEST_MISSING');
  response = await request(`${engine}/api/sonic/engine/health`);
  ensure(response.status === 401 && (await json(response)).error?.code === 'ENGINE_UNAUTHORIZED', 'ENGINE_ANONYMOUS_GATE_FAILED');
  const engineHealth = await health(engine, secrets);
  const release = engineHealth.release;
  ensure(release?.environment === 'staging' && release.engineIdentityCompiled === true && releaseMatches(release, manifest), 'ENGINE_RELEASE_IDENTITY_MISMATCH');
  ensure(engineHealth.recommendEngine.persistenceExpected === true && engineHealth.recommendEngine.storageHealthy === true &&
    engineHealth.recommendEngine.disk?.writable === true, 'STAGING_ENGINE_STORAGE_NOT_WRITABLE');
  ensure(engineHealth.recommendEngine.erasureRecoveryVersion === 1, 'STAGING_ENGINE_ERASURE_RECOVERY_UNVERIFIED');
  ensure(engineHealth.readiness?.identity?.ok === true && engineHealth.readiness.identity.configured === true && engineHealth.readiness.identity.required === true, 'ENGINE_IDENTITY_NOT_READY');
  ensure(edgeHealth.readiness?.identity?.ok === true && edgeHealth.readiness.identity.configured === true, 'EDGE_IDENTITY_NOT_READY');
  response = await request(`${engine}/release.json`, { headers: { 'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET } });
  ensure(response.status === 200 && frontendMatches(await json(response), manifest), 'ENGINE_FRONTEND_MANIFEST_MISMATCH');
  passed('Pages and Engine release identities match and direct Engine health is private and durable');
  return {
    pagesArtifactDigest,
    stagingRateLimit: edgeHealth.rateLimit,
    stagingAccess: edgeHealth.readiness?.access,
    stagingContentPolicy: { pages: contentPolicyEvidence(edgeHealth), engine: contentPolicyEvidence(engineHealth) },
    engineStorage: engineHealth.recommendEngine.storageKind,
    engineErasureRecoveryVersion: engineHealth.recommendEngine.erasureRecoveryVersion,
    engineRelease: {
      baseCommit: release.releaseCommit,
      sourceDigest: release.sourceDigest,
      releaseId: release.releaseId,
      buildTime: release.buildTime,
      dirty: release.dirty,
      engineIdentityCompiled: release.engineIdentityCompiled,
    },
  };
}
async function verifySearchAndMedia(base, headers, manifest) {
  let response = await request(`${base}/api/music/search?q=Sonic&source=synthetic&count=5`, { headers });
  ensure(response.status === 200 && response.headers.get('x-sonic-via') === 'local-engine', 'SEARCH_ENGINE_PROVENANCE_FAILED');
  const search = await json(response);
  ensure(search.via === 'local-engine' && search.degraded === false && search.tracks?.some(track => ['syn-440hz', 'synthetic:syn-440hz'].includes(track.id)), 'SYNTHETIC_SEARCH_RESULT_FAILED');
  passed('synthetic search returns real catalog results through the staging Engine');
  const stream = `${base}/api/music/stream?id=syn-440hz&source=synthetic`;
  const mediaHeaders = response => {
    ensure(response.headers.get('x-sonic-via') === 'local-engine' && response.headers.get('x-sonic-provider') === 'local-synthetic', 'MEDIA_ENGINE_PROVENANCE_FAILED');
    ensure(response.headers.get('x-sonic-degraded') !== '1', 'MEDIA_DEGRADED_FALLBACK');
    ensure(response.headers.get('x-sonic-release') === manifest.releaseId, 'MEDIA_RELEASE_HEADER_MISMATCH');
  };
  response = await request(stream, { method: 'HEAD', headers });
  ensure(response.status === 200 && /^audio\//i.test(response.headers.get('content-type') || '') && Number(response.headers.get('content-length')) > 44, 'MEDIA_HEAD_FAILED');
  mediaHeaders(response);
  ensure((await bytes(response)).length === 0, 'MEDIA_HEAD_HAS_BODY');
  response = await request(stream, { headers: { ...headers, Range: 'bytes=0-43' } });
  ensure(response.status === 206 && /^bytes 0-43\/[0-9]+$/.test(response.headers.get('content-range') || ''), 'MEDIA_INITIAL_RANGE_FAILED');
  mediaHeaders(response);
  const wav = await bytes(response);
  ensure(wav.length === 44 && wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE', 'MEDIA_WAV_BYTES_INVALID');
  response = await request(stream, { headers: { ...headers, Range: 'bytes=16000-16031' } });
  ensure(response.status === 206 && /^bytes 16000-16031\/[0-9]+$/.test(response.headers.get('content-range') || ''), 'MEDIA_SEEK_RANGE_FAILED');
  mediaHeaders(response);
  ensure((await bytes(response)).length === 32, 'MEDIA_SEEK_BYTES_INVALID');
  response = await request(stream, { headers: { ...headers, Range: 'bytes=999999999999-' } });
  ensure(response.status === 416 && /^bytes \*\/[0-9]+$/.test(response.headers.get('content-range') || ''), 'MEDIA_UNSATISFIABLE_RANGE_FAILED');
  mediaHeaders(response);
  await discard(response);
  passed('Engine-backed audio HEAD, RIFF bytes, seek ranges 206 and invalid range 416');
}
function signIdentity(secrets, subject, mode, method, path, secretOverride) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: subject, mode, consent: mode !== 'public', method, path, iat: now, exp: now + 30 })).toString('base64url');
  const signature = createHmac('sha256', secretOverride || secrets.SONIC_ENGINE_IDENTITY_SECRET).update('sonic-engine-identity-v1.' + encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function subjectFor(prefix, raw) {
  return prefix + '_' + createHash('sha256').update(`sonic-subj-v1:${prefix}:${raw}`).digest('hex').slice(0, 24);
}
function isEventEpoch(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}
async function verifyErasureEpoch(send, readEngine, priorEpoch, eventPayload, privacyMode) {
  const delayed = eventPayload('delayed', priorEpoch);
  const { data: erased } = await send({ method: 'DELETE' });
  ensure(erased?.cleared === true && erased.removedEvents === 1 && erased.storageKind === 'sqlite' &&
    isEventEpoch(erased.eventEpoch) && erased.eventEpoch !== priorEpoch, 'DURABLE_ERASURE_EPOCH_NOT_ROTATED');
  const { data: stateAfterErase } = await readEngine();
  ensure(stateAfterErase?.totalEvents === 0 && stateAfterErase.eventEpoch === erased.eventEpoch, 'ERASURE_EPOCH_NOT_PERSISTED');

  const rejected = await send({ method: 'POST', body: delayed, status: 409 });
  ensure(rejected.error?.code === 'EVENT_EPOCH_MISMATCH' && rejected.data?.eventEpoch === erased.eventEpoch &&
    rejected.data.privacyMode === privacyMode, 'STALE_EVENT_EPOCH_NOT_REJECTED');
  ensure((await readEngine()).data?.totalEvents === 0, 'STALE_EVENT_MUTATED_ERASED_SUBJECT');

  const current = eventPayload('current', erased.eventEpoch);
  const accepted = await send({ method: 'POST', body: current });
  ensure(accepted.data?.accepted === 1 && accepted.data?.storageKind === 'sqlite' &&
    accepted.meta?.via === 'local-engine', 'CURRENT_EVENT_EPOCH_NOT_ACKNOWLEDGED');
  const { data: final } = await readEngine();
  ensure(final?.totalEvents === 1 && final.eventEpoch === erased.eventEpoch &&
    final.recentQueries?.includes(current.events[0].query) && !final.recentQueries.includes(delayed.events[0].query), 'CURRENT_EVENT_EPOCH_NOT_PERSISTED');
}

export async function verifyEvents(base, engine, headers, secrets) {
  const run = randomBytes(12).toString('hex');
  const subjects = [`anon_live_${run}_a`, `anon_live_${run}_b`];
  const queries = [`live-${run}-a`, `live-${run}-b`];
  const engineHeaders = { 'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET };
  async function events(origin, subject, { method = 'GET', body, extra = {}, query = '', status = 200 } = {}) {
    const path = '/api/sonic/events' + query;
    const identity = origin === base
      ? { ...headers, 'X-Sonic-Anon-Id': subject, 'X-Sonic-Personalization': 'on' }
      : { ...engineHeaders,
          'X-Sonic-Verified-Identity': signIdentity(secrets, subjectFor('anon', subject), 'anonymous-opt-in', method, path),
          'X-Sonic-Identity-Required': '1' };
    const response = await request(`${origin}${path}`, {
      method,
      headers: { ...identity, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    ensure(response.status === status, status === 409 ? 'STALE_EVENT_EPOCH_NOT_REJECTED' : 'EVENTS_HTTP_FAILED');
    ensure(/private/.test(response.headers.get('cache-control') || '') && /no-store/.test(response.headers.get('cache-control') || ''), 'EVENTS_PRIVACY_CACHE_FAILED');
    const value = await json(response);
    ensure(value.brand === 'Sonic', 'EVENTS_RESPONSE_INVALID');
    return value;
  }
  const payload = (index, eventEpoch, suffix = '') => ({
    eventEpoch,
    events: [{ type: 'search', query: `${queries[index]}${suffix}`, eventId: `live_event_${run}${suffix}` }],
  });
  const epochs = [];
  const ingestTarget = { 'X-Sonic-Event-Target': 'anonymous-opt-in' };
  const erasureTarget = { 'X-Sonic-Erasure-Target': 'anonymous-opt-in' };
  try {
    for (const subject of subjects) {
      const value = await events(base, subject);
      ensure(value.data?.totalEvents === 0 && value.data?.privacyMode === 'anonymous-opt-in' && value.data?.storageKind === 'sqlite' &&
        (value.data.eventEpoch === null || isEventEpoch(value.data.eventEpoch)), 'NEW_SUBJECT_NOT_EMPTY_OR_DURABLE');
      epochs.push(value.data.eventEpoch);
    }
    const ignored = await events(base, subjects[0], { method: 'POST', body: payload(0, epochs[0]), extra: { 'X-Sonic-Personalization': 'off' } });
    ensure(ignored.data?.accepted === 0 && ignored.data?.ignoredByPrivacy === 1 && ignored.data?.storageKind === 'none', 'EXPLICIT_CONSENT_OPT_OUT_FAILED');
    for (const query of ['?personalize=0', '?personalization=off', '?personalize=on&personalization=false']) {
      const optedOut = await events(base, subjects[0], { method: 'POST', body: payload(0, epochs[0]), query });
      ensure(optedOut.data?.accepted === 0 && optedOut.data?.ignoredByPrivacy === 1 && optedOut.data?.privacyMode === 'public', 'QUERY_CONSENT_HOP_FAILED');
    }
    for (let index = 0; index < subjects.length; index++) {
      const accepted = await events(base, subjects[index], { method: 'POST', body: payload(index, epochs[index]), extra: ingestTarget });
      ensure(accepted.data?.accepted === 1 && accepted.data?.storageKind === 'sqlite' && accepted.meta?.via === 'local-engine', 'EVENT_NOT_ACKNOWLEDGED_BY_DURABLE_ENGINE');
    }
    const retry = await events(base, subjects[0], { method: 'POST', body: payload(0, epochs[0]), extra: ingestTarget });
    ensure(retry.data?.accepted === 0 && retry.data?.deduplicated === 1 && retry.data?.storageKind === 'sqlite', 'EVENT_RETRY_IDEMPOTENCY_FAILED');
    for (let index = 0; index < subjects.length; index++) {
      for (const origin of [base, engine]) {
        const value = await events(origin, subjects[index]);
        ensure(value.data?.totalEvents === 1 && value.data?.storageKind === 'sqlite' && value.data?.recentQueries?.includes(queries[index]) && !value.data.recentQueries.includes(queries[1 - index]), 'EVENT_SUBJECT_ISOLATION_OR_ENGINE_PARITY_FAILED');
      }
    }
    await verifyErasureEpoch(
      options => events(base, subjects[0], { ...options, extra: options.method === 'DELETE' ? erasureTarget : ingestTarget }),
      () => events(engine, subjects[0]),
      epochs[0],
      (label, epoch) => payload(0, epoch, `-${label}`),
      'anonymous-opt-in',
    );
    ensure((await events(engine, subjects[1])).data?.totalEvents === 1, 'DELETE_CROSSED_SUBJECT_BOUNDARY');
  } finally {
    // These fresh random subjects belong exclusively to this run; never delete existing tester data.
    let cleanupFailed = false;
    for (const subject of subjects) {
      try {
        const result = await events(engine, subject, { method: 'DELETE', extra: erasureTarget });
        ensure(result.data?.cleared === true && result.data?.storageKind === 'sqlite', 'TEST_SUBJECT_CLEANUP_FAILED');
        ensure((await events(engine, subject)).data?.totalEvents === 0, 'TEST_SUBJECT_CLEANUP_FAILED');
      } catch { cleanupFailed = true; }
    }
    ensure(!cleanupFailed, 'TEST_SUBJECT_CLEANUP_FAILED');
  }
  passed('anonymous consent, durable isolation, deduplication and erasure epoch verified through Pages and Engine');
  passed('temporary live-test subjects deleted and absence confirmed directly on Engine');
}
export async function verifyAuthenticatedIdentity(base, engine, headers, secrets) {
  ensure(secrets.SONIC_SECRET && secrets.SONIC_ENGINE_IDENTITY_SECRET, 'AUTHENTICATED_STAGING_KEYS_MISSING');
  const id = randomBytes(12).toString('hex');
  const email = `staging-validation-${id}@example.invalid`;
  const subject = subjectFor('usr', email);
  const now = Math.floor(Date.now() / 1000);
  const kid = 'k_' + createHash('sha256').update(secrets.SONIC_SECRET).digest('hex').slice(0, 12);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'sonic-api-key', v: 2, kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: email, iat: now, exp: now + 300, jti: 'staging_' + id, kid, role: 'user', uid: 'test_' + id })).toString('base64url');
  const input = `sonic_live_v2.${header}.${payload}`;
  const token = input + '.' + createHmac('sha256', secrets.SONIC_SECRET).update(input).digest('base64url');
  const path = '/api/sonic/events';
  async function call(origin, { method = 'GET', body, status = 200 } = {}) {
    const auth = origin === base ? { ...headers, 'X-Sonic-Key': token,
      ...(method === 'POST' ? { 'X-Sonic-Event-Target': `account:test_${id}` } : {}),
      ...(method === 'DELETE' ? { 'X-Sonic-Erasure-Target': `account:test_${id}` } : {}),
    } : {
      'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET,
      'X-Sonic-Verified-Identity': signIdentity(secrets, subject, 'authenticated', method, path),
      'X-Sonic-Identity-Required': '1',
    };
    const response = await request(origin + path, { method, headers: { ...auth, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    ensure(response.status === status, status === 409 ? 'STALE_EVENT_EPOCH_NOT_REJECTED' : 'AUTHENTICATED_HOP_HTTP_FAILED');
    ensure(/private/.test(response.headers.get('cache-control') || '') && /no-store/.test(response.headers.get('cache-control') || ''), 'EVENTS_PRIVACY_CACHE_FAILED');
    const value = await json(response);
    ensure(value.brand === 'Sonic' && value.data?.privacyMode === 'authenticated' &&
      (status !== 200 || value.data?.storageKind === 'sqlite'), 'AUTHENTICATED_HOP_DOWNGRADED');
    return value;
  }
  const eventPayload = (label, eventEpoch) => ({ eventEpoch, events: [{
    type: 'search', query: `authenticated-staging-${id}-${label}`, eventId: `authenticated_${id}_${label}`,
  }] });
  try {
    const { data: initial } = await call(base);
    ensure(initial.totalEvents === 0 && (initial.eventEpoch === null || isEventEpoch(initial.eventEpoch)), 'AUTH_TEST_SUBJECT_NOT_EMPTY');
    const posted = await call(base, { method: 'POST', body: eventPayload('initial', initial.eventEpoch) });
    ensure(posted.data.accepted === 1 && posted.meta?.via === 'local-engine', 'AUTH_TEST_WRITE_NOT_ACKNOWLEDGED');
    ensure((await call(engine)).data.totalEvents === 1, 'AUTH_TEST_ENGINE_SUBJECT_MISMATCH');
    await verifyErasureEpoch(options => call(base, options), () => call(engine), initial.eventEpoch, eventPayload, 'authenticated');
    const wrong = await request(engine + path, { headers: {
      'X-Sonic-Engine-Key': secrets.SONIC_ENGINE_SECRET,
      'X-Sonic-Verified-Identity': signIdentity(secrets, subject, 'authenticated', 'GET', path, randomBytes(32).toString('hex')),
      'X-Sonic-Identity-Required': '1',
    } });
    ensure(wrong.status === 503 && (await json(wrong)).error?.code === 'ENGINE_IDENTITY_UNAVAILABLE', 'IDENTITY_MISMATCH_NOT_REJECTED');
    passed('authenticated subject parity, erasure epoch and invalid Engine signature rejection');
  } finally {
    const { data: cleanup } = await call(engine, { method: 'DELETE' });
    ensure(cleanup.cleared === true && (await call(engine)).data.totalEvents === 0, 'AUTH_TEST_CLEANUP_FAILED');
  }
}

async function browserBootstrap(base, token, lifetimeMs = 10 * 60 * 1000) {
  const invitation = new URL(`${previewUrl(base)}/`);
  invitation.searchParams.set('staging_token', token);
  let destination = invitation.toString();
  let used = false;
  const server = createServer((req, res) => {
    const host = `127.0.0.1:${server.address()?.port}`;
    const valid = req.method === 'GET' && req.url === '/enter' && req.headers.host === host &&
      (!req.headers.origin || req.headers.origin === `http://${host}`);
    const responseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' };
    if (!valid || used) { res.writeHead(404, responseHeaders); res.end(); return; }
    used = true;
    res.writeHead(302, { ...responseHeaders, Location: destination });
    res.end();
    destination = '';
    server.close();
  });
  server.on('clientError', (_, socket) => { socket.destroy(); });
  await new Promise((done, reject) => {
    server.once('error', () => reject(new SafeError('LOCAL_BROWSER_BOOTSTRAP_FAILED')));
    server.listen(0, '127.0.0.1', done);
  });
  const timer = setTimeout(() => server.close(), lifetimeMs);
  server.on('close', () => { clearTimeout(timer); destination = ''; });
  return { server, url: `http://127.0.0.1:${server.address().port}/enter` };
}
async function selfTest() {
  for (const invalid of ['https://cfsolara-dho.pages.dev/', 'https://sonic-staging.pages.dev/', 'https://rc-test.sonic-staging.pages.dev.evil.test/', 'https://rc-test.sonic-staging.pages.dev/?staging_token=test', 'http://rc-test.sonic-staging.pages.dev/']) {
    let rejected = false;
    try { previewUrl(invalid); } catch (error) { rejected = error instanceof SafeError; }
    ensure(rejected, 'SELF_TEST_PREVIEW_TARGET_GUARD_FAILED');
  }
  const base = 'https://rc-self-test.sonic-staging.pages.dev';
  ensure(previewUrl(base) === base, 'SELF_TEST_VALID_TARGET_FAILED');
  const token = 'self-test-placeholder-access-value';
  const bridge = await browserBootstrap(base, token, 5000);
  try {
    let response = await request(bridge.url, { headers: { Origin: 'https://outside.example' } });
    ensure(response.status === 404, 'SELF_TEST_BRIDGE_ORIGIN_GUARD_FAILED');
    await discard(response);
    response = await request(bridge.url);
    const expected = new URL(`${base}/`);
    expected.searchParams.set('staging_token', token);
    ensure(response.status === 302 && response.headers.get('location') === expected.toString() && response.headers.get('referrer-policy') === 'no-referrer', 'SELF_TEST_BRIDGE_REDIRECT_FAILED');
    await discard(response);
  } finally { bridge.server.close(); }
  console.log(JSON.stringify({ ok: true, checks: ['production and unscoped URLs rejected', 'only isolated staging HTTPS hosts accepted', 'loopback bridge rejects external Origin', 'one-use private invitation redirect has no-referrer and no-store'] }));
}
async function main() {
  const { values } = parseArgs({ options: { preflight: { type: 'boolean' }, stable: { type: 'boolean' }, 'serve-browser': { type: 'boolean' }, 'self-test': { type: 'boolean' }, manifest: { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('Read-only stable Staging preflight: node scripts/verify-staging-live.mjs --preflight\nPost-deploy checks: node scripts/verify-staging-live.mjs [--manifest path] [--url isolated-preview-url]\nStable Staging checks: node scripts/verify-staging-live.mjs --stable\nLegacy gate checks and one-use browser entry: node scripts/verify-staging-live.mjs --serve-browser\nLocal security checks: node scripts/verify-staging-live.mjs --self-test\nExisting Cloudflare auth and the fixed authorized SSH connection are required. Product invite checks use a dedicated disposable SONIC_STAGING_TEST_INVITE_CODE from the environment. Live checks create fresh random subjects and verify their cleanup.');
    return;
  }
  if (values['self-test']) return selfTest();
  ensure(!(values.preflight && (values.url || values['serve-browser'])), 'PREFLIGHT_OPTIONS_CONFLICT');
  ensure(!(values.stable && values['serve-browser']), 'STABLE_BROWSER_BRIDGE_NOT_SUPPORTED');
  const project = await projectMetadata(Boolean(values.stable || values.preflight));
  const { accessGateMode, inviteGateBlockers, stagingAccessNamespaceId } = project.metadata;
  ensure(!(accessGateMode === 'invite' && values['serve-browser']), 'INVITE_BROWSER_REDEMPTION_REQUIRES_FORM');
  // Non-deploying preflight can diagnose legacy or incomplete configuration;
  // live candidate acceptance must use the isolated durable invite flow.
  if (!values.preflight && !values['serve-browser']) ensure(inviteGateBlockers.length === 0, inviteGateBlockers[0]);
  const saved = await credentials(accessGateMode);
  const secrets = saved.credentials || {};
  try {
    ensure(Boolean(secrets?.SONIC_ENGINE_SECRET && (accessGateMode === 'invite' || secrets.SONIC_STAGING_ACCESS_TOKEN)), 'STAGING_ACCESS_CREDENTIALS_MISSING');
    if (values.preflight) {
      if (accessGateMode === 'invite') await verifyInviteGate(project.metadata.publicStagingUrl);
      else await verifyLegacyAccess(project.metadata.publicStagingUrl, secrets);
      const engine = await health(project.metadata.engineUrl, secrets);
      passed('existing Engine accepts the preserved inter-service key and reports durable readiness');
      console.log(JSON.stringify({ ok: true, mode: 'read-only-preflight', ...project.metadata, credentialFile: { path: envPath, mode: saved.mode, presence: saved.presence, savedMatchesRunning: saved.savedMatchesRunning }, currentEngineRelease: engine.release, checks }, null, 2));
      return;
    }
    const manifest = readJson(resolve(root, values.manifest || 'dist/release.json'));
    validateManifest(manifest);
    const target = await selectDeployment(project.apiPath, manifest, values.url, Boolean(values.stable));
    const verifyCandidate = async headers => {
      const pairedRelease = await verifyRelease(target.base, project.metadata.engineUrl, headers, secrets, manifest);
      if (!values['serve-browser']) ensure(durablePagesInviteReady(pairedRelease.stagingAccess), 'STAGING_DURABLE_INVITE_HEALTH_NOT_READY');
      if (values.stable) ensure(/^[a-f0-9]{32}$/.test(project.metadata.stagingRateLimitNamespaceId || '') &&
        strictEdgeRateLimitReady(pairedRelease.stagingRateLimit), 'STABLE_STAGING_SHARED_RATE_LIMITER_UNVERIFIED');
      await verifySearchAndMedia(target.base, headers, manifest);
      ensure(project.metadata.independentIdentityBindingPresent && secrets.SONIC_ENGINE_IDENTITY_SECRET, 'INDEPENDENT_IDENTITY_NOT_DEPLOYED');
      await verifyEvents(target.base, project.metadata.engineUrl, headers, secrets);
      await verifyAuthenticatedIdentity(target.base, project.metadata.engineUrl, headers, secrets);
      return pairedRelease;
    };
    const inviteAccessLiveVerified = accessGateMode === 'invite';
    const { result: pairedRelease, inviteSessionRevocationDurable, inviteSingleUseLiveVerified } = inviteAccessLiveVerified
      ? await withInviteAccess(target.base, process.env.SONIC_STAGING_TEST_INVITE_CODE, manifest, verifyCandidate, { requireDurable: true })
      : { result: await verifyCandidate(await verifyLegacyAccess(target.base, secrets, manifest)), inviteSessionRevocationDurable: null, inviteSingleUseLiveVerified: false };
    if (values['serve-browser']) {
      const bridge = await browserBootstrap(target.base, secrets.SONIC_STAGING_ACCESS_TOKEN);
      // The only stdout is this local URL. Invitation and Cookie values stay in memory.
      console.log(bridge.url);
      const stop = () => bridge.server.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } else {
      console.log(JSON.stringify({
        ok: true, mode: 'staging-live', ...target, ...manifest, ...pairedRelease,
        stagingEngineImageId: saved.imageId, stagingRateLimitNamespaceId: project.metadata.stagingRateLimitNamespaceId,
        accessGateMode, stagingAccessNamespaceId, inviteAccessLiveVerified, inviteSingleUseLiveVerified, inviteSessionRevocationDurable,
        independentIdentityBindingPresent: project.metadata.independentIdentityBindingPresent,
        authenticatedIdentityAssertionLiveVerified: true, eventEpochLiveVerified: true, oauthLoginVerified: false,
        authenticationLimitation: 'Ephemeral signed staging subjects exercise the identity hop. External OAuth requires separate verification.', checks,
      }, null, 2));
    }
  } finally {
    for (const key of Object.keys(secrets)) secrets[key] = '';
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof SafeError ? error.message : 'STAGING_VERIFICATION_FAILED';
    console.error(JSON.stringify({ ok: false, code, checks }, null, 2));
    process.exitCode = 1;
  });
}
