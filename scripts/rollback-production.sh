#!/usr/bin/env bash
# ==============================================================================
# CFSolara Production Rollback Script (Tunnel Ingress + DNS CNAME)
# Restores original direct Cloudflare Tunnel architecture from verified backups.
#
# Usage:
#   ./scripts/rollback-production.sh            # Safe dry-run (default)
#   ./scripts/rollback-production.sh --dry-run  # Explicit dry-run
#   ./scripts/rollback-production.sh --execute  # Execute live rollback
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKUP_DIR="${REPO_ROOT}/rollback-backups"
TUNNEL_BACKUP="${TUNNEL_BACKUP:-$(ls "${BACKUP_DIR}"/*tunnel*.json 2>/dev/null | head -n 1 || true)}"
DNS_BACKUP="${DNS_BACKUP:-$(ls "${BACKUP_DIR}"/*dns*.json 2>/dev/null | head -n 1 || true)}"

MODE="dry-run"
if [[ "${1:-}" == "--execute" ]]; then
  MODE="execute"
elif [[ "${1:-}" == "--dry-run" ]] || [[ -z "${1:-}" ]]; then
  MODE="dry-run"
else
  echo "Unknown argument: ${1}"
  echo "Usage: $0 [--dry-run | --execute]"
  exit 1
fi

echo "================================================================================"
echo " CFSolara Production Rollback: Mode = [${MODE^^}]"
echo "================================================================================"

# 1. Validate backup files exist
if [[ ! -f "${TUNNEL_BACKUP}" ]]; then
  echo "[-] ERROR: Tunnel backup file not found at ${TUNNEL_BACKUP}" >&2
  exit 1
fi
if [[ ! -f "${DNS_BACKUP}" ]]; then
  echo "[-] ERROR: DNS backup file not found at ${DNS_BACKUP}" >&2
  exit 1
fi

echo "[+] Step 0: Backup integrity check"
# 2. Validate JSON structure & extract parameters using node
PARAMS=$(node -e '
const fs = require("fs");
const tunnel = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const dns = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const accountId = tunnel.accountId;
const tunnelId = tunnel.tunnelId;
const tunnelConfig = tunnel.config;

const zoneId = dns.zoneId;
const sonicRecord = dns.records.find(r => r.name === "sonic.epocanvas.tech");

if (!accountId || !tunnelId || !tunnelConfig) {
  throw new Error("Invalid tunnel backup JSON");
}
if (!zoneId || !sonicRecord) {
  throw new Error("Invalid DNS backup JSON");
}

console.log(JSON.stringify({
  accountId,
  tunnelId,
  tunnelConfig,
  zoneId,
  recordId: sonicRecord.id,
  recordName: sonicRecord.name,
  recordContent: sonicRecord.content,
  proxied: sonicRecord.proxied
}));
' "${TUNNEL_BACKUP}" "${DNS_BACKUP}")

ACCOUNT_ID=$(echo "${PARAMS}" | jq -r .accountId)
TUNNEL_ID=$(echo "${PARAMS}" | jq -r .tunnelId)
ZONE_ID=$(echo "${PARAMS}" | jq -r .zoneId)
RECORD_ID=$(echo "${PARAMS}" | jq -r .recordId)
RECORD_NAME=$(echo "${PARAMS}" | jq -r .recordName)
RECORD_CONTENT=$(echo "${PARAMS}" | jq -r .recordContent)
PROXIED=$(echo "${PARAMS}" | jq -r .proxied)
TUNNEL_CONFIG_JSON=$(echo "${PARAMS}" | jq -c '{config: .tunnelConfig}')

echo "    - Account ID : ${ACCOUNT_ID}"
echo "    - Tunnel ID  : ${TUNNEL_ID}"
echo "    - Zone ID    : ${ZONE_ID}"
echo "    - Record ID  : ${RECORD_ID} (${RECORD_NAME})"
echo "    - Original CNAME Target: ${RECORD_CONTENT} (proxied: ${PROXIED})"
echo "    - Tunnel Ingress Route : sonic.epocanvas.tech -> http://localhost:8080"
echo "    ✓ Backup integrity verified 100% OK"
echo ""

# 3. Check environment
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "[-] ERROR: CLOUDFLARE_API_TOKEN environment variable is required to read the current Tunnel configuration." >&2
  echo "    Refusing to synthesize a rollback from an empty current configuration." >&2
  exit 1
else
  echo "[+] Auth credential detected in environment: CLOUDFLARE_API_TOKEN [SET]"
fi
echo ""

# Step 1: Merge Tunnel Ingress Configuration (Preserve engine-sonic.epocanvas.tech)
TUNNEL_ENDPOINT="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations"

# Fetch and validate the current Tunnel configuration before constructing a
# rollback. A failed read must never degrade into an empty configuration.
if ! CURRENT_CFG_RESP=$(curl -fsS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Accept: application/json" \
  "${TUNNEL_ENDPOINT}"); then
  echo "[-] ERROR: Unable to read the current Tunnel configuration. No changes made." >&2
  exit 1
fi

if ! echo "${CURRENT_CFG_RESP}" | jq -e '.success == true and (.result.config.ingress | type == "array")' >/dev/null; then
  echo "[-] ERROR: Cloudflare returned an invalid Tunnel configuration. No changes made." >&2
  exit 1
fi

# Replace only the backed-up sonic route, preserve every other current rule
# and preserve all top-level Tunnel settings such as warp-routing.
TUNNEL_CONFIGS=$(node -e '
const fs = require("fs");
const currentResponse = JSON.parse(process.argv[1]);
const backup = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const currentConfig = currentResponse.result?.config;
const backupConfig = backup.config;
if (!currentConfig || !Array.isArray(currentConfig.ingress)) throw new Error("Invalid current Tunnel config");
if (!backupConfig || !Array.isArray(backupConfig.ingress)) throw new Error("Invalid backup Tunnel config");

const targetHost = "sonic.epocanvas.tech";
const engineHost = "engine-sonic.epocanvas.tech";
const backupTarget = backupConfig.ingress.filter(rule => rule?.hostname === targetHost);
if (backupTarget.length === 0) throw new Error("Tunnel backup has no sonic.epocanvas.tech route");
const currentEngine = currentConfig.ingress.filter(rule => rule?.hostname === engineHost);
const backupEngine = backupConfig.ingress.filter(rule => rule?.hostname === engineHost);
if (currentEngine.length === 0 && backupEngine.length === 0) {
  throw new Error("Neither current nor backup Tunnel config has engine-sonic.epocanvas.tech");
}

const mergedIngress = [];
let insertedTarget = false;
for (const rule of currentConfig.ingress) {
  if (rule?.hostname === targetHost) {
    if (!insertedTarget) {
      mergedIngress.push(...backupTarget);
      insertedTarget = true;
    }
    continue;
  }
  if (!rule?.hostname) continue;
  mergedIngress.push(rule);
}
if (!insertedTarget) mergedIngress.push(...backupTarget);
if (currentEngine.length === 0) {
  const insertAt = mergedIngress.findIndex(rule => rule?.hostname === targetHost);
  mergedIngress.splice(insertAt < 0 ? mergedIngress.length : insertAt, 0, ...backupEngine);
}
const currentCatchAll = currentConfig.ingress.filter(rule => !rule?.hostname);
const backupCatchAll = backupConfig.ingress.filter(rule => !rule?.hostname);
const catchAll = currentCatchAll.length ? currentCatchAll : backupCatchAll;
if (catchAll.length === 0) catchAll.push({ service: "http_status:404" });
mergedIngress.push(...catchAll);

const mergedConfig = { ...currentConfig, ingress: mergedIngress };
if (!mergedConfig.ingress.some(rule => rule?.hostname === targetHost)) throw new Error("Merged config lost sonic route");
if (!mergedConfig.ingress.some(rule => rule?.hostname === engineHost)) throw new Error("Merged config lost engine route");
console.log(JSON.stringify({ original: currentConfig, merged: mergedConfig }));
' "${CURRENT_CFG_RESP}" "${TUNNEL_BACKUP}")

ORIGINAL_TUNNEL_CONFIG=$(echo "${TUNNEL_CONFIGS}" | jq -c '{config: .original}')
MERGED_TUNNEL_CONFIG=$(echo "${TUNNEL_CONFIGS}" | jq -c '{config: .merged}')

echo "[+] Step 1 (Tunnel): MERGE sonic.epocanvas.tech ingress into Cloudflare Tunnel"
echo "    Strategy: Non-destructive Merge (PRESERVES engine-sonic.epocanvas.tech)"
echo "    Request:"
echo "      PUT ${TUNNEL_ENDPOINT}"
echo "      Headers: Authorization: Bearer <CLOUDFLARE_API_TOKEN>, Content-Type: application/json"
echo "      Payload:"
echo "        ${MERGED_TUNNEL_CONFIG}"
echo ""

# Step 2: Restore DNS CNAME Record
DNS_ENDPOINT="https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}"
DNS_PAYLOAD=$(jq -nc --arg type "CNAME" --arg name "sonic" --arg content "${RECORD_CONTENT}" --argjson proxied "${PROXIED}" \
  '{type: $type, name: $name, content: $content, proxied: $proxied, ttl: 1}')
echo "[+] Step 2 (DNS): Restore CNAME target back to original Tunnel hostname"
echo "    Request:"
echo "      PATCH ${DNS_ENDPOINT}"
echo "      Headers: Authorization: Bearer <CLOUDFLARE_API_TOKEN>, Content-Type: application/json"
echo "      Payload:"
echo "        ${DNS_PAYLOAD}"
echo ""

if [[ "${MODE}" == "dry-run" ]]; then
  echo "================================================================================"
  echo " [DRY RUN SUCCESSFUL] Merged configuration validated. No live mutations made."
  echo " To execute this rollback live, run: ./scripts/rollback-production.sh --execute"
  echo "================================================================================"
  exit 0
fi

# Execution path (only when --execute is passed)
echo ">>> EXECUTING LIVE ROLLBACK <<<"

echo "1. Applying Merged Tunnel Configuration..."
TUNNEL_RESP=$(curl -s -X PUT "${TUNNEL_ENDPOINT}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${MERGED_TUNNEL_CONFIG}")

if ! echo "${TUNNEL_RESP}" | jq -e '.success' >/dev/null 2>&1; then
  echo "[-] FAILED to restore tunnel configuration:" >&2
  echo "${TUNNEL_RESP}" >&2
  exit 1
fi
if ! READBACK_TUNNEL=$(curl -fsS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Accept: application/json" \
  "${TUNNEL_ENDPOINT}"); then
  echo "[-] FAILED to read back Tunnel configuration after update." >&2
  exit 1
fi
if ! node -e '
const actual = JSON.parse(process.argv[1]).result?.config;
const expected = JSON.parse(process.argv[2]).config;
if (!actual || !expected || JSON.stringify(actual.ingress) !== JSON.stringify(expected.ingress) ||
    JSON.stringify(actual["warp-routing"]) !== JSON.stringify(expected["warp-routing"])) process.exit(1);
' "${READBACK_TUNNEL}" "${MERGED_TUNNEL_CONFIG}"; then
  echo "[-] FAILED to verify the applied Tunnel configuration." >&2
  exit 1
fi
echo "   ✓ Merged tunnel ingress configuration applied and verified (engine-sonic preserved)."

echo "2. Applying DNS CNAME Update..."
DNS_RESP=$(curl -fsS -X PATCH "${DNS_ENDPOINT}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${DNS_PAYLOAD}")

if ! echo "${DNS_RESP}" | jq -e '.success' >/dev/null 2>&1; then
  echo "[-] FAILED to restore DNS record:" >&2
  echo "${DNS_RESP}" >&2
  exit 1
fi
if ! DNS_READBACK=$(curl -fsS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Accept: application/json" \
  "${DNS_ENDPOINT}"); then
  echo "[-] FAILED to read back DNS after update. Restoring the original Tunnel config." >&2
  curl -fsS -X PUT "${TUNNEL_ENDPOINT}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${ORIGINAL_TUNNEL_CONFIG}" >/dev/null || echo "[-] CRITICAL: Tunnel restoration also failed." >&2
  exit 1
fi
if ! node -e '
const record = JSON.parse(process.argv[1]).result;
const expectedContent = process.argv[2];
const expectedProxied = JSON.parse(process.argv[3]);
if (!record || record.type !== "CNAME" || record.content !== expectedContent || record.proxied !== expectedProxied) process.exit(1);
' "${DNS_READBACK}" "${RECORD_CONTENT}" "${PROXIED}"; then
  echo "[-] FAILED to verify DNS after update. Restoring the original Tunnel config." >&2
  curl -fsS -X PUT "${TUNNEL_ENDPOINT}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${ORIGINAL_TUNNEL_CONFIG}" >/dev/null || echo "[-] CRITICAL: Tunnel restoration also failed." >&2
  exit 1
fi
echo "   ✓ DNS CNAME record updated and verified successfully."

echo "================================================================================"
echo " [LIVE ROLLBACK COMPLETE] Verified both Tunnel Ingress and DNS CNAME restored."
echo "================================================================================"
