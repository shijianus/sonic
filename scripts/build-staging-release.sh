#!/usr/bin/env bash
set -euo pipefail
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELEASE_DIR"
python3 - <<'PY'
import json, os, pathlib, re, subprocess
root = pathlib.Path.cwd()
subprocess.run(['node', 'scripts/release-inputs.mjs', '--verify', 'release.json', '--index', 'release-files.json'], check=True)
m = json.loads((root / 'release.json').read_text())
assert m.get('schemaVersion') == 1
assert re.fullmatch(r'[a-f0-9]{40}', m['baseCommit'])
assert re.fullmatch(r'[a-f0-9]{64}', m['sourceDigest'])
assert re.fullmatch(r'[a-zA-Z0-9._-]{7,128}', m['releaseId'])
old = json.loads(subprocess.check_output(['docker','inspect','sonic-staging-engine']))[0]
EXPECTED_OLD_IMAGE_ID = os.environ.get('SONIC_EXPECTED_STAGING_IMAGE_ID', '')
assert re.fullmatch(r'sha256:[0-9a-f]{64}', EXPECTED_OLD_IMAGE_ID), 'SONIC_EXPECTED_STAGING_IMAGE_ID is required'
assert old['Config']['Image'].startswith('sonic-staging-engine:') or old['Config']['Image'] == EXPECTED_OLD_IMAGE_ID
assert old['Image'] == EXPECTED_OLD_IMAGE_ID
assert re.fullmatch(r'sha256:[0-9a-f]{64}', old['Image'])
data_source = os.environ.get('SONIC_STAGING_DATA_DIR', '')
assert data_source, 'SONIC_STAGING_DATA_DIR is required'
assert any(x['Source'] == data_source and x['Destination'] == '/app/data' for x in old['Mounts'])
assert any(x['HostIp'] == '127.0.0.1' and x['HostPort'] == '18080' for x in old['HostConfig']['PortBindings']['8080/tcp'])
assert old['State']['Running']
image = 'sonic-staging-engine:fix-' + m['sourceDigest'][:12]
args = ['docker','build','-t',image]
for key, value in {'SONIC_RELEASE_COMMIT':m['baseCommit'],'SONIC_BUILD_TIME':m['buildTime'],'SONIC_RELEASE_ID':m['releaseId'],'SONIC_SOURCE_DIGEST':m['sourceDigest'],'SONIC_RELEASE_DIRTY':str(m['dirty']).lower()}.items():
    args += ['--build-arg', key + '=' + value]
args += ['.']
subprocess.run(args, check=True)
inspected = json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
labels = inspected['Config']['Labels']
assert labels['tech.epocanvas.sonic.release-id'] == m['releaseId']
assert labels['tech.epocanvas.sonic.source-digest'] == m['sourceDigest']
result = {'ok':True,'phase':'image-built','release':m,'image':image,'imageId':inspected['Id'],'previousStagingImage':old['Config']['Image'],'previousStagingImageId':old['Image'],'previousStagingData':data_source}
(root/'remote-build-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
PY
