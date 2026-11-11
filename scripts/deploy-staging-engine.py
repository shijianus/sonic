import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import time


def staging_source_env(raw_sources):
    # Keep this list aligned with docs/CONTENT-LICENSING-MATRIX.md. Operators
    # must opt in to real sources for the same-artifact Staging media checks.
    approved = {
        'netease': 'SONIC_ENABLE_NETEASE', 'qq': 'SONIC_ENABLE_QQ',
        'kugou': 'SONIC_ENABLE_KUGOU', 'kuwo': 'SONIC_ENABLE_KUWO',
        'amll': 'SONIC_ENABLE_AMLL', 'lrclib': 'SONIC_ENABLE_LRCLIB',
    }
    selected = [part.strip() for part in raw_sources.split(',')] if raw_sources.strip() else []
    if len(set(selected)) != len(selected) or any(source not in approved for source in selected):
        raise ValueError('SONIC_STAGING_APPROVED_SOURCES must list distinct approved IDs: ' + ','.join(approved))
    return {
        'SONIC_CONTENT_POLICY': 'strict-allowlist',
        'SONIC_ALLOWED_SOURCES': ','.join(['synthetic', *selected]),
        'SONIC_ENABLE_SYNTHETIC_TEST_SOURCE': '1',
        **{flag: '1' if source in selected else '0' for source, flag in approved.items()},
        'SONIC_ENABLE_GDSTUDIO': '0', 'SONIC_ENABLE_LYRIVA': '0',
        'SONIC_ENABLE_UNBLOCK': '0', 'SONIC_ENABLE_FREE_CROSS_MATCH': '0',
    }


try:
    source_env = staging_source_env(os.environ.get('SONIC_STAGING_APPROVED_SOURCES', ''))
except ValueError as error:
    raise SystemExit(str(error)) from None
if sys.argv[1:] == ['--check-source-policy']:
    print(json.dumps(source_env))
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit('Usage: deploy-staging-engine.py [--check-source-policy]')

root = pathlib.Path(__file__).resolve().parent.parent
build = json.loads((root / 'remote-build-result.json').read_text())
candidate = json.loads((root / 'remote-candidate-result.json').read_text())
release = build['release']
assert build.get('ok') is True and build.get('phase') == 'image-built'
assert re.fullmatch(r'[a-f0-9]{64}', release['sourceDigest'])
assert re.fullmatch(r'sha256:[0-9a-f]{64}', build['imageId'])
assert candidate.get('ok') is True and candidate.get('phase') == 'candidate-validated'
assert candidate['sourceDigest'] == release['sourceDigest'] and candidate['releaseId'] == release['releaseId']
assert candidate['image'] == build['imageId'] and candidate['port'] == 18082
assert len(candidate['checks']) >= 12 and candidate['oldSchemaSnapshot']['ok'] is True
name = 'sonic-staging-engine'
backup_name = name + '-rollback-' + release['sourceDigest'][:12]
image = build['imageId']
expected_old = os.environ.get('SONIC_EXPECTED_STAGING_IMAGE_ID', '')
assert re.fullmatch(r'sha256:[0-9a-f]{64}', expected_old), 'SONIC_EXPECTED_STAGING_IMAGE_ID is required'
data_dir = pathlib.Path(os.environ['SONIC_STAGING_DATA_DIR'])
env_file = pathlib.Path(os.environ['SONIC_STAGING_ENV_FILE'])
identity_file = pathlib.Path(os.environ['SONIC_STAGING_IDENTITY_FILE'])
rollback_data = root / 'rollback-data'


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]) + ' (exit ' + str(result.returncode) + ')')
    return result.stdout.strip()


def inspect(container):
    return json.loads(run(['docker', 'inspect', container]))[0]


def exists(container):
    return subprocess.run(['docker', 'inspect', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def health(container):
    script = "fetch('http://127.0.0.1:8080/api/sonic/engine/health',{headers:{'X-Sonic-Engine-Key':process.env.SONIC_ENGINE_SECRET||''},signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.json();if(!r.ok||!b.ok)process.exit(2);console.log(JSON.stringify({release:b.release,storage:b.recommendEngine.storageKind,erasureRecoveryVersion:b.recommendEngine.erasureRecoveryVersion,ok:b.ok,flags:b.flags,licensing:b.licensing,identity:b.readiness?.identity}))}).catch(()=>process.exit(3))"
    return json.loads(run(['docker', 'exec', container, 'node', '-e', script]))


def wait_health(container):
    for _ in range(60):
        try:
            return health(container)
        except (RuntimeError, ValueError):
            time.sleep(1)
    raise RuntimeError('Staging health did not become ready')


def deployment_identity():
    current = inspect(name)
    assert current['Image'] == image
    assert current['HostConfig']['PortBindings']['8080/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]
    assert any(m['Source'] == str(data_dir) and m['Destination'] == '/app/data' for m in current['Mounts'])
    effective = dict(v.split('=', 1) for v in current['Config']['Env'])
    for key, value in values.items():
        assert effective.get(key) == value, 'Staging configuration mismatch: ' + key
    return current


def snapshot_files(directory):
    result = {}
    for entry in sorted(directory.rglob('*')):
        assert not entry.is_symlink(), 'Refusing a data snapshot containing symlinks'
        if entry.is_file():
            result[str(entry.relative_to(directory))] = hashlib.sha256(entry.read_bytes()).hexdigest()
    return result


old = inspect(name)
assert old['State']['Running'] and old['Config']['Image'] == build['previousStagingImage']
assert old['Image'] == build['previousStagingImageId'] == expected_old
assert any(m['Source'] == str(data_dir) and m['Destination'] == '/app/data' for m in old['Mounts'])
assert old['HostConfig']['PortBindings']['8080/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]
assert env_file.is_file() and stat.S_IMODE(env_file.stat().st_mode) == 0o600
assert identity_file.is_file() and stat.S_IMODE(identity_file.stat().st_mode) == 0o600
identity_lines = identity_file.read_text().splitlines()
assert len(identity_lines) == 1 and identity_lines[0].startswith('SONIC_ENGINE_IDENTITY_SECRET=')
assert len(identity_lines[0].split('=', 1)[1].strip()) >= 32
assert not exists(backup_name) and not rollback_data.exists()
labels = json.loads(run(['docker', 'image', 'inspect', image]))[0]['Config']['Labels']
assert labels['tech.epocanvas.sonic.release-id'] == release['releaseId']
assert labels['tech.epocanvas.sonic.source-digest'] == release['sourceDigest']
assert labels['org.opencontainers.image.revision'] == release['baseCommit']
assert data_dir.is_dir() and not data_dir.is_symlink()
assert shutil.disk_usage(data_dir).free > sum(p.stat().st_size for p in data_dir.rglob('*') if p.is_file()) * 3 + 256 * 1024 * 1024
before = health(name)
backup_path = '/app/data/pre-release-' + release['sourceDigest'][:12] + '.sqlite'
backup_script = "const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const crypto=require('node:crypto');const src=process.env.SONIC_RECOMMEND_DB_PATH||'/app/data/sonic-recommend.sqlite';const dst=process.argv[1];if(fs.existsSync(dst))throw Error('backup exists');const db=new DatabaseSync(src);db.exec(\"VACUUM INTO '\"+dst.replaceAll(\"'\",\"''\")+\"'\");db.close();fs.chmodSync(dst,0o600);const b=new DatabaseSync(dst,{readOnly:true});if(b.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('backup invalid');const tables={};for(const{name}of b.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all()){tables[name]=Number(b.prepare('SELECT COUNT(*) AS n FROM \"'+name.replaceAll('\"','\"\"')+'\"').get().n)}b.close();console.log(JSON.stringify({ok:true,destination:dst,tables,sha256:crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex')}));"
backup = json.loads(run(['docker', 'exec', name, 'node', '--experimental-sqlite', '-e', backup_script, backup_path]))
assert backup['ok'] and re.fullmatch(r'[a-f0-9]{64}', backup['sha256'])
assert hashlib.sha256((data_dir / pathlib.Path(backup_path).name).read_bytes()).hexdigest() == backup['sha256']
(root / 'staging-pre-release-backup.json').write_text(json.dumps({'previousRelease': before, 'backup': backup, 'image': old['Config']['Image'], 'imageId': old['Image'], 'rollbackContainer': backup_name}, indent=2) + '\n')
values = {'SONIC_ENV': 'staging', 'SONIC_RUNTIME': 'linux-engine', 'SONIC_REQUIRE_ENGINE_IDENTITY': '1', 'SONIC_RELEASE_COMMIT': release['baseCommit'], 'SONIC_RELEASE_ID': release['releaseId'], 'SONIC_SOURCE_DIGEST': release['sourceDigest'], 'SONIC_RELEASE_DIRTY': str(release['dirty']).lower(), 'SONIC_BUILD_TIME': release['buildTime'], 'SONIC_SHUTDOWN_TIMEOUT_MS': '60000', 'SONIC_RECOMMEND_DB_PATH': '/app/data/sonic-recommend.sqlite', 'SONIC_LOCAL_ENGINE_URL': '', 'SONIC_NCM_API_URL': '', 'SONIC_NCM_REQUIRED': '0', 'SONIC_REQUIRE_AUTH': '0', 'SONIC_ENABLE_OAUTH': '0', **source_env}
renamed = False
stopped = False
launch_attempted = False
try:
    run(['docker', 'stop', '--time', '75', name])
    stopped = True
    assert not inspect(name)['State']['Running']
    snapshot = snapshot_files(data_dir)
    shutil.copytree(data_dir, rollback_data)
    assert snapshot_files(rollback_data) == snapshot
    (root / 'staging-rollback-files.json').write_text(json.dumps(snapshot, indent=2) + '\n')
    run(['docker', 'rename', name, backup_name])
    renamed = True
    args = ['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', '--stop-timeout', '75', '--env-file', str(env_file), '--env-file', str(identity_file), '-p', '127.0.0.1:18080:8080', '-v', str(data_dir) + ':/app/data']
    for k, v in values.items():
        args += ['-e', k + '=' + v]
    # Once the new process may have accepted requests, an older directory or
    # binary could resurrect an erased profile. Retain the live data and guard.
    launch_attempted = True
    run(args + [image])
    deployment_identity()
    after = wait_health(name)
    assert after['ok'] and after['storage'] == 'sqlite' and after['erasureRecoveryVersion'] == 1
    assert after['release']['releaseId'] == release['releaseId'] and after['release']['sourceDigest'] == release['sourceDigest']
    assert after['release']['environment'] == 'staging' and after['release']['engineIdentityCompiled'] is True
    assert after['identity']['ok'] and after['identity']['configured'] and after['identity']['required']
    assert sorted(after['licensing']['allowedSources']) == sorted(values['SONIC_ALLOWED_SOURCES'].split(','))
    assert after['flags']['contentPolicy'] == 'strict-allowlist' and not after['flags']['enableOAuth']
    result = {'ok': True, 'phase': 'staging-engine-deployed', 'releaseId': release['releaseId'], 'sourceDigest': release['sourceDigest'], 'image': image, 'previousImage': old['Config']['Image'], 'rollbackContainer': backup_name, 'backup': backup, 'health': after, 'bind': '127.0.0.1:18080', 'dataMount': str(data_dir)}
    (root / 'staging-deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
except Exception as failure:
    rollback = {'ok': False, 'phase': 'staging-deployment-failed', 'rollbackReady': False}
    try:
        if launch_attempted:
            if exists(name):
                deployment_identity()
                run(['docker', 'stop', '--time', '75', name])
                assert not inspect(name)['State']['Running']
            rollback['rollbackError'] = 'Candidate may have served requests; preserved current data and recovery guard. Use an erasure-compatible recovery target.'
        elif renamed:
            assert inspect(backup_name)['Image'] == expected_old
            run(['docker', 'rename', backup_name, name])
        if stopped and not launch_attempted:
            assert inspect(name)['Image'] == expected_old
            run(['docker', 'start', name])
            restored = wait_health(name)
            assert restored['ok'] and restored['storage'] == 'sqlite'
            rollback['rollbackReady'] = True
    except Exception:
        rollback['rollbackError'] = 'Manual staging recovery required; preserved container and data snapshots must be inspected'
    (root / 'staging-deployment-failure.json').write_text(json.dumps(rollback, indent=2) + '\n')
    print(json.dumps(rollback, indent=2))
    raise RuntimeError('Staging deployment failed; rollbackReady=' + str(rollback['rollbackReady'])) from None
