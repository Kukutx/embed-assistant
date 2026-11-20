#!/usr/bin/env bash
# Turn on off-site backups for a VM made by create-vm.sh. Run it in OCI Cloud Shell:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/embed-assistant/main/deploy/oracle-cloud/offsite-backup.sh)
#
# It creates (or reuses) a private Object Storage bucket "embed-assistant-backups" in the
# VM's compartment and a write-only pre-authenticated request for it (it can add objects,
# not read, list or delete them), and stores that URL in the VM's instance metadata. The
# daily backup.sh on the VM reads it from there, so the URL is never copied by hand.
# Backups older than KEEP_DAYS (default 35) are deleted by a bucket lifecycle rule, so
# erased data does not live on in old copies and the bucket stays small.
# Object Storage is free up to 20 GB; a backup of a pilot is a few MB a day.
#
# Safe to run again: it reuses the bucket and replaces the URL.
set -euo pipefail

NAME=${NAME:-embed-assistant}
BUCKET=${BUCKET:-embed-assistant-backups}
YEARS=${YEARS:-5}
KEEP_DAYS=${KEEP_DAYS:-35}
command -v oci >/dev/null || { echo "Run this in OCI Cloud Shell (the oci CLI is needed)."; exit 1; }
C=${COMPARTMENT_ID:-${OCI_TENANCY:-}}
[ -n "$C" ] || { echo "Set COMPARTMENT_ID (Cloud Shell sets OCI_TENANCY automatically)."; exit 1; }
REGION=${OCI_REGION:-$(oci iam region-subscription list --query 'data[?"is-home-region"]|[0]."region-name"' --raw-output)}

trap 'echo "Stopped at line $LINENO (exit code $?)."' ERR
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
val() { local v; v=$("$@" 2>/dev/null || true); [ "$v" = "null" ] && v=""; printf '%s' "$v"; }

say "Finding the VM \"$NAME\""
ID=$(val oci compute instance list -c "$C" --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
[ -n "$ID" ] || { echo "No running instance named $NAME in this compartment."; exit 1; }

say "Bucket $BUCKET"
NS=$(oci os ns get --query data --raw-output)
if [ -z "$(val oci os bucket get --bucket-name "$BUCKET" --query 'data.name' --raw-output)" ]; then
  oci os bucket create -c "$C" --name "$BUCKET" --public-access-type NoPublicAccess >/dev/null
fi

say "Delete backups after $KEEP_DAYS days"
# Object Storage runs lifecycle rules as a service, which needs a policy allowing it.
if [ "$C" = "${OCI_TENANCY:-}" ]; then WHERE="tenancy"; else WHERE="compartment id $C"; fi
POLICY=embed-assistant-backup-lifecycle
if [ -z "$(val oci iam policy list -c "$C" --name "$POLICY" --query 'data[0].id' --raw-output)" ]; then
  oci iam policy create -c "$C" --name "$POLICY" --description "Object Storage lifecycle rules for embed-assistant backups" \
    --statements "[\"Allow service objectstorage-$REGION to manage object-family in $WHERE\"]" >/dev/null ||
    echo "Could not create the IAM policy $POLICY (an administrator can add it)."
fi
RULE="[{\"name\":\"delete-old-backups\",\"action\":\"DELETE\",\"target\":\"objects\",\"timeAmount\":$KEEP_DAYS,\"timeUnit\":\"DAYS\",\"isEnabled\":true,\"objectNameFilter\":{\"inclusionPrefixes\":[\"embed-assistant-\"]}}]"
kept=""
for _ in 1 2 3 4 5 6; do # a new policy can take a few seconds to apply
  if oci os object-lifecycle-policy put --bucket-name "$BUCKET" --items "$RULE" --force >/dev/null 2>&1; then kept=1; break; fi
  sleep 10
done
[ -n "$kept" ] || echo "Could not set the lifecycle rule yet (the new policy may need a minute); run this script again later."

say "Write-only access for the VM"
# Earlier upload URLs stop working: only the newest one is kept.
for old in $(val oci os preauth-request list --bucket-name "$BUCKET" --all --query "data[?name=='$NAME-backup-write'].id" --raw-output | tr -d '[]",'); do
  oci os preauth-request delete --bucket-name "$BUCKET" --par-id "$old" --force >/dev/null
done
EXPIRES=$(date -u -d "+$YEARS years" +%Y-%m-%dT%H:%M:%SZ)
URI=$(oci os preauth-request create --bucket-name "$BUCKET" --name "$NAME-backup-write" \
  --access-type AnyObjectWrite --time-expires "$EXPIRES" --query 'data."access-uri"' --raw-output)
URL="https://objectstorage.$REGION.oraclecloud.com$URI"
oci compute instance update --instance-id "$ID" --force \
  --extended-metadata "{\"embed_assistant_backup_url\":\"$URL\"}" >/dev/null

say "Done"
echo "The VM uploads each daily backup (03:30 UTC) to bucket $BUCKET (namespace $NS, region $REGION); copies older than $KEEP_DAYS days are deleted."
echo "Restore: download a .dump from the bucket in the console, then see deploy/single-server/README.md."
