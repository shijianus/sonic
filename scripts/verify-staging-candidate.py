import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
build = json.loads((root / 'remote-build-result.json').read_text())
release = build['release']
assert build.get('ok') is True and build.get('phase') == 'image-built'
assert re.fullmatch(r'[a-f0-9]{64}', release['sourceDigest'])
assert re.fullmatch(r'sha256:[0-9a-f]{64}', build.get('imageId', ''))
image = build['imageId']
expected_old = os.environ.get('SONIC_EXPECTED_STAGING_IMAGE_ID', '')
assert re.fullmatch(r'sha256:[0-9a-f]{64}', expected_old), 'SONIC_EXPECTED_STAGING_IMAGE_ID is required'
name = 'sonic-candidate-' + release['sourceDigest'][:12]
volume = name
key, signing, identity_key = (secrets.token_hex(32) for _ in range(3))
port = 18082
checks = []
host_snapshot = root / 'old-staging-upgrade.sqlite'
old_snapshot = '/tmp/' + name + '-upgrade.sqlite'
snapshot_created = False


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]) + ' (exit ' + str(result.returncode) + ')')
    return result.stdout.strip()


def inspect(container):
    return json.loads(run(['docker', 'inspect', container]))[0]


def candidate_identity():
    current = inspect(name)
    assert current['Image'] == image
    assert current['HostConfig']['PortBindings']['8080/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]
    assert any(m.get('Name') == volume and m['Destination'] == '/app/data' for m in current['Mounts'])
    return current


def sign_identity(method, path, subject='usr_' + 'a' * 24, mode='authenticated', secret=None):
    now = int(time.time())
    payload = {'v': 1, 'sub': subject, 'mode': mode, 'consent': mode != 'public', 'method': method, 'path': path, 'iat': now, 'exp': now + 30}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).rstrip(b'=')
    signature = hmac.new((secret or identity_key).encode(), b'sonic-engine-identity-v1.' + encoded, hashlib.sha256).digest()
    return encoded.decode() + '.' + base64.urlsafe_b64encode(signature).rstrip(b'=').decode()


def http(path, method='GET', data=None, extra=None, auth=True):
    headers = {'X-Sonic-Engine-Key': key} if auth else {}
    headers.update(extra or {})
    anon = headers.get('X-Sonic-Anon-Id')
    if auth and anon and 'X-Sonic-Verified-Identity' not in headers:
        subject = 'anon_' + hashlib.sha256(('sonic-subj-v1:anon:' + anon).encode()).hexdigest()[:24]
        headers['X-Sonic-Verified-Identity'] = sign_identity(method, path, subject, 'anonymous-opt-in')
        headers['X-Sonic-Identity-Required'] = '1'
    body = json.dumps(data).encode() if data is not None else None
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(f'http://127.0.0.1:{port}' + path, method=method, data=body, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read()


def ready():
    for _ in range(60):
        try:
            status, _, body = http('/api/sonic/engine/health')
            if status == 200:
                value = json.loads(body)
                assert value['ok'] and value['recommendEngine']['storageKind'] == 'sqlite'
                assert value['release']['releaseId'] == release['releaseId']
                assert value['release']['sourceDigest'] == release['sourceDigest']
                assert value['readiness']['identity']['ok'] and value['readiness']['identity']['required']
                return value
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Candidate readiness failed')


def start(environment):
    args = ['docker', 'run', '-d', '--name', name, '--stop-timeout', '75', '-p', f'127.0.0.1:{port}:8080', '-v', volume + ':/app/data']
    values = {'SONIC_ENGINE_SECRET': key, 'SONIC_SECRET': signing, 'SONIC_ENGINE_IDENTITY_SECRET': identity_key, 'SONIC_REQUIRE_ENGINE_IDENTITY': '1', 'SONIC_ENV': environment, 'SONIC_REQUIRE_AUTH': '0', 'SONIC_ENABLE_OAUTH': '0', 'SONIC_CONTENT_POLICY': 'strict-allowlist', 'SONIC_ALLOWED_SOURCES': 'synthetic', 'SONIC_ENABLE_SYNTHETIC_TEST_SOURCE': '1', 'SONIC_LOCAL_ENGINE_URL': '', 'SONIC_NCM_API_URL': '', 'SONIC_SHUTDOWN_TIMEOUT_MS': '60000'}
    values.update({k: '0' for k in ['SONIC_ENABLE_NETEASE', 'SONIC_ENABLE_QQ', 'SONIC_ENABLE_KUGOU', 'SONIC_ENABLE_KUWO', 'SONIC_ENABLE_GDSTUDIO', 'SONIC_ENABLE_LYRIVA', 'SONIC_ENABLE_AMLL', 'SONIC_ENABLE_LRCLIB', 'SONIC_ENABLE_UNBLOCK']})
    secret_env = os.environ.copy()
    for k, v in values.items():
        if k in ['SONIC_ENGINE_SECRET', 'SONIC_SECRET', 'SONIC_ENGINE_IDENTITY_SECRET']:
            secret_env[k] = v
            args += ['-e', k]
        else:
            args += ['-e', k + '=' + v]
    run(args + [image], env=secret_env)
    candidate_identity()
    ready()


def stop_remove():
    candidate_identity()
    run(['docker', 'stop', '--time', '75', name])
    assert candidate_identity()['State']['ExitCode'] == 0, 'Candidate did not exit cleanly'
    run(['docker', 'rm', name])


assert inspect('sonic-staging-engine')['Image'] == expected_old == build['previousStagingImageId']
labels = json.loads(run(['docker', 'image', 'inspect', image]))[0]['Config']['Labels']
assert labels['tech.epocanvas.sonic.source-digest'] == release['sourceDigest']
assert labels['tech.epocanvas.sonic.release-id'] == release['releaseId']
assert subprocess.run(['docker', 'container', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0, 'Candidate name already exists'
assert subprocess.run(['docker', 'volume', 'inspect', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0, 'Candidate volume already exists'
assert not host_snapshot.exists()
run(['docker', 'volume', 'create', volume])
try:
    start('staging')
    snapshot_js = "const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const crypto=require('node:crypto');const dst=process.argv[1];if(fs.existsSync(dst))throw Error('snapshot exists');const db=new DatabaseSync(process.env.SONIC_RECOMMEND_DB_PATH||'/app/data/sonic-recommend.sqlite');db.exec(\"VACUUM INTO '\"+dst+\"'\");db.close();fs.chmodSync(dst,0o600);const b=new DatabaseSync(dst,{readOnly:true});if(b.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('invalid snapshot');const tables={};for(const{name}of b.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all()){tables[name]=Number(b.prepare('SELECT COUNT(*) AS n FROM \"'+name.replaceAll('\"','\"\"')+'\"').get().n)}b.close();console.log(JSON.stringify({ok:true,tables,sha256:crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex')}));"
    snapshot = json.loads(run(['docker', 'exec', 'sonic-staging-engine', 'node', '--experimental-sqlite', '-e', snapshot_js, old_snapshot]))
    snapshot_created = True
    run(['docker', 'cp', 'sonic-staging-engine:' + old_snapshot, str(host_snapshot)])
    host_snapshot.chmod(0o600)
    assert hashlib.sha256(host_snapshot.read_bytes()).hexdigest() == snapshot['sha256']
    with sqlite3.connect('file:' + str(host_snapshot) + '?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    run(['docker', 'cp', str(host_snapshot), name + ':/tmp/old-staging-upgrade.sqlite'])
    run(['docker', 'exec', '--user', '0', name, 'chown', 'node:node', '/tmp/old-staging-upgrade.sqlite'])
    migration_js = "import{createSonicServer,shutdownSonicServer}from'./dist-server/index.mjs';import{DatabaseSync}from'node:sqlite';const file='/tmp/old-staging-upgrade.sqlite';function counts(){const db=new DatabaseSync(file,{readOnly:true});if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('integrity');const tables={};for(const{name}of db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all()){tables[name]=Number(db.prepare('SELECT COUNT(*) AS n FROM \"'+name.replaceAll('\"','\"\"')+'\"').get().n)}db.close();return tables}const before=counts();const server=createSonicServer('/app/dist',{SONIC_RECOMMEND_DB_PATH:file});await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;const r=await fetch('http://127.0.0.1:'+p+'/api/sonic/engine/health',{headers:{'X-Sonic-Engine-Key':process.env.SONIC_ENGINE_SECRET}});const h=await r.json();if(!r.ok||!h.ok)throw Error('migration health');const after=counts();for(const[k,n]of Object.entries(before))if(after[k]!==n)throw Error('migration count mismatch: '+k);await shutdownSonicServer(server);console.log('SONIC_MIGRATION_RESULT='+JSON.stringify({ok:true,tables:before,storage:h.recommendEngine.storageKind}));"
    output = run(['docker', 'exec', name, 'node', '--experimental-sqlite', '--input-type=module', '-e', migration_js])
    records = [line[len('SONIC_MIGRATION_RESULT='):] for line in output.splitlines() if line.startswith('SONIC_MIGRATION_RESULT=')]
    assert len(records) == 1
    migrated = json.loads(records[0])
    assert migrated['ok'] and migrated['storage'] == 'sqlite' and migrated['tables'] == snapshot['tables']
    checks.append('migrates a verified copy of the real old staging schema without losing table rows')
    checks.append('candidate readiness and immutable release identity')
    for path in ['/api/sonic/engine/health', '/proxy', '/proxy/', '/proxy///', '/palette', '/palette/']:
        assert http(path, auth=False)[0] == 401, path
    checks.append('engine auth covers normalized route variants')
    status, _, body = http('/release.json')
    assert status == 200 and json.loads(body) == release
    checks.append('frontend and backend manifest match')
    stream = '/api/music/stream?id=syn-440hz&source=synthetic'
    assert http(stream, method='HEAD')[0] == 200
    status, _, body = http(stream, extra={'Range': 'bytes=0-43'})
    assert status == 206 and len(body) == 44 and body[:4] == b'RIFF'
    status, _, body = http(stream, extra={'Range': 'bytes=16000-16031'})
    assert status == 206 and len(body) == 32
    assert http(stream, extra={'Range': 'bytes=9999999999-'})[0] == 416
    checks.append('synthetic media HEAD and seek ranges 206/416')
    status, _, body = http('/api/sonic/events', extra={'X-Sonic-Verified-Identity': sign_identity('GET', '/api/sonic/events')})
    assert status == 200 and json.loads(body)['data']['privacyMode'] == 'authenticated'
    checks.append('actual image verifies the independent signed subject assertion')
    invalid = sign_identity('GET', '/api/sonic/events', secret='wrong-key-at-least-32-characters-long')
    assert http('/api/sonic/events', extra={'X-Sonic-Verified-Identity': invalid})[0] == 503
    assert http('/api/sonic/events', extra={'X-Sonic-Identity-Required': '1'})[0] == 503
    checks.append('invalid or missing required identity never downgrades to anonymous success')
    consent_path = '/api/sonic/events?personalize=0'
    opted_out = http(consent_path, 'POST', {'events': [{'type': 'search', 'query': 'must-not-persist', 'eventId': 'candidate_optout'}]}, {'X-Sonic-Verified-Identity': sign_identity('POST', consent_path, None, 'public')})
    assert opted_out[0] == 200 and json.loads(opted_out[2])['data']['ignoredByPrivacy'] == 1
    checks.append('signed opt-out ignores events without persistence')
    for subject in ['anon_candidate_user_a_20261102', 'anon_candidate_user_b_20261102']:
        status, _, body = http('/api/sonic/events', 'POST', {'events': [{'type': 'search', 'query': 'candidate-persistence', 'eventId': 'candidate_same_event_20261102'}]}, {'X-Sonic-Anon-Id': subject, 'X-Sonic-Personalization': 'on'})
        assert status == 200 and json.loads(body)['data']['accepted'] == 1
    status, _, body = http('/api/sonic/events', 'POST', {'events': [{'type': 'search', 'query': 'candidate-persistence', 'eventId': 'candidate_same_event_20261102'}]}, {'X-Sonic-Anon-Id': 'anon_candidate_user_a_20261102', 'X-Sonic-Personalization': 'on'})
    assert status == 200 and json.loads(body)['data']['deduplicated'] == 1
    checks.append('cross-subject idempotency with durable SQLite')
    backup = json.loads(run(['docker', 'exec', name, 'node', '--experimental-sqlite', 'scripts/backup-recommend-db.mjs', '/app/data/sonic-recommend.sqlite', '/app/data/candidate-backup.sqlite']))
    assert backup['ok'] and backup['events'] == 2
    rejected = subprocess.run(['docker', 'exec', name, 'node', '--experimental-sqlite', 'scripts/restore-recommend-db.mjs', '/app/data/candidate-backup.sqlite', '/app/data/sonic-recommend.sqlite', '--offline'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert rejected.returncode != 0 and 'active or uncheckpointed' in rejected.stderr
    checks.append('online WAL backup and live restore refusal')
    stop_remove()
    checks.append('SIGTERM drains and exits zero')
    restored = json.loads(run(['docker', 'run', '--rm', '--entrypoint', 'node', '-v', volume + ':/app/data', image, '--experimental-sqlite', 'scripts/restore-recommend-db.mjs', '/app/data/candidate-backup.sqlite', '/app/data/sonic-recommend.sqlite', '--offline']))
    assert restored['ok'] and restored['events'] == 2
    checks.append('offline verified restore inside the actual runtime image')
    start('staging')
    status, _, body = http('/api/sonic/events', extra={'X-Sonic-Anon-Id': 'anon_candidate_user_a_20261102', 'X-Sonic-Personalization': 'on'})
    assert status == 200 and json.loads(body)['data']['totalEvents'] == 1
    checks.append('events survive image/container recreation')
    stop_remove()
    start('production')
    assert http(stream)[0] in [403, 404]
    checks.append('production rejects explicitly enabled synthetic sources')
    stop_remove()
    result = {'ok': True, 'phase': 'candidate-validated', 'releaseId': release['releaseId'], 'sourceDigest': release['sourceDigest'], 'image': image, 'checks': checks, 'oldSchemaSnapshot': snapshot, 'candidateVolume': volume, 'port': port}
    (root / 'remote-candidate-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
finally:
    if subprocess.run(['docker', 'container', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        candidate_identity()
        run(['docker', 'stop', '--time', '75', name])
        run(['docker', 'rm', name])
    if host_snapshot.exists():
        host_snapshot.unlink()
    if snapshot_created:
        assert inspect('sonic-staging-engine')['Image'] == expected_old
        run(['docker', 'exec', 'sonic-staging-engine', 'node', '-e', "require('node:fs').unlinkSync(process.argv[1])", old_snapshot])
