#!/usr/bin/env bash
# Create an Always Free Arm VM on Oracle Cloud and install embed-assistant on it.
# Run it in OCI Cloud Shell (already signed in; nothing to configure):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/embed-assistant/main/deploy/oracle-cloud/create-vm.sh) "ssh-ed25519 AAAA... you@host"
#
# The argument is the SSH public key that may log in as `ubuntu`. The script creates (or
# reuses) a VCN "embed-assistant" with ports 22, 80 and 443 open, launches a
# VM.Standard.A1.Flex instance (OCPUS, default 1; MEMORY_GB, default 6) with Ubuntu 24.04,
# and keeps retrying while the region answers "Out of host capacity" (RETRY_MINUTES,
# default 180). On first boot the VM runs deploy/single-server/install.sh, so the console is
# at https://<ip-with-dashes>.sslip.io/admin/ a few minutes after the IP is printed.
# Model keys are added afterwards over SSH (see deploy/oracle-cloud/README.md).
#
# Safe to run again: it reuses the network and stops if the instance already exists.
set -euo pipefail

PUBKEY=${1:-}
NAME=${NAME:-embed-assistant}
OCPUS=${OCPUS:-1}
MEMORY_GB=${MEMORY_GB:-6}
RETRY_MINUTES=${RETRY_MINUTES:-180}
SHAPE=VM.Standard.A1.Flex
RAW=${RAW:-https://raw.githubusercontent.com/Kukutx/embed-assistant/main}

case "$PUBKEY" in ssh-*|ecdsa-*) ;; *) echo "Usage: create-vm.sh \"<ssh public key>\""; exit 1 ;; esac
command -v oci >/dev/null || { echo "Run this in OCI Cloud Shell (the oci CLI is needed)."; exit 1; }
C=${COMPARTMENT_ID:-${OCI_TENANCY:-}}
[ -n "$C" ] || { echo "Set COMPARTMENT_ID (Cloud Shell sets OCI_TENANCY automatically)."; exit 1; }

trap 'echo "Stopped at line $LINENO (exit code $?)."' ERR
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
val() { local v; v=$("$@" 2>/dev/null || true); [ "$v" = "null" ] && v=""; printf '%s' "$v"; }

say "Checking for an existing instance"
for state in RUNNING PROVISIONING STARTING STOPPED; do
  ID=$(val oci compute instance list -c "$C" --display-name "$NAME" --lifecycle-state "$state" --query 'data[0].id' --raw-output)
  [ -n "$ID" ] && break
done

if [ -z "$ID" ]; then
  say "Network"
  VCN=$(val oci network vcn list -c "$C" --display-name "$NAME" --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output)
  if [ -z "$VCN" ]; then
    VCN=$(oci network vcn create -c "$C" --display-name "$NAME" --cidr-blocks '["10.20.0.0/16"]' \
      --dns-label embedasst --wait-for-state AVAILABLE --query data.id --raw-output)
  fi
  IGW=$(val oci network internet-gateway list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output)
  if [ -z "$IGW" ]; then
    IGW=$(oci network internet-gateway create -c "$C" --vcn-id "$VCN" --display-name "$NAME" \
      --is-enabled true --wait-for-state AVAILABLE --query data.id --raw-output)
  fi
  RT=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
  oci network route-table update --rt-id "$RT" --force \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
  tcp() { printf '{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":%s,"max":%s}}}' "$1" "$1"; }
  INGRESS="[$(tcp 22),$(tcp 80),$(tcp 443),{\"source\":\"0.0.0.0/0\",\"protocol\":\"17\",\"isStateless\":false,\"udpOptions\":{\"destinationPortRange\":{\"min\":443,\"max\":443}}}]"
  EGRESS='[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]'
  SL=$(val oci network security-list list -c "$C" --vcn-id "$VCN" --display-name "$NAME" --query 'data[0].id' --raw-output)
  if [ -z "$SL" ]; then
    SL=$(oci network security-list create -c "$C" --vcn-id "$VCN" --display-name "$NAME" \
      --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" \
      --wait-for-state AVAILABLE --query data.id --raw-output)
  else
    oci network security-list update --security-list-id "$SL" --force \
      --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" >/dev/null
  fi
  SUB=$(val oci network subnet list -c "$C" --vcn-id "$VCN" --display-name "$NAME" --query 'data[0].id' --raw-output)
  if [ -z "$SUB" ]; then
    SUB=$(oci network subnet create -c "$C" --vcn-id "$VCN" --display-name "$NAME" --cidr-block 10.20.0.0/24 \
      --dns-label pub --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
      --wait-for-state AVAILABLE --query data.id --raw-output)
  fi

  say "Image"
  IMG=$(oci compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all --query 'data[0].id' --raw-output 2>/dev/null)
  [ -n "$IMG" ] && [ "$IMG" != "null" ] || { echo "No Ubuntu 24.04 image for $SHAPE in this region."; exit 1; }
  mapfile -t ADS < <(oci iam availability-domain list -c "$C" --query 'data[].name' --raw-output | tr -d '[]", ' | grep .)
  [ "${#ADS[@]}" -gt 0 ] || { echo "No availability domains found."; exit 1; }

  WORK=$(mktemp -d)
  printf '%s\n' "$PUBKEY" > "$WORK/key.pub"
  cat > "$WORK/user-data.sh" <<EOF
#!/bin/bash
# Retry: on first boot apt may still be locked by the image's own updates.
for i in 1 2 3 4 5; do
  curl -fsSL $RAW/deploy/single-server/install.sh -o /root/install.sh &&
    bash /root/install.sh >> /var/log/embed-assistant-install.log 2>&1 && break
  sleep 60
done
EOF

  say "Launching $SHAPE ($OCPUS OCPU, $MEMORY_GB GB); retrying for up to $RETRY_MINUTES minutes if capacity is full"
  deadline=$(( $(date +%s) + RETRY_MINUTES * 60 ))
  attempt=0
  while [ -z "$ID" ]; do
    for AD in "${ADS[@]}"; do
      attempt=$((attempt + 1))
      if out=$(oci compute instance launch -c "$C" --availability-domain "$AD" --display-name "$NAME" \
          --shape "$SHAPE" --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
          --image-id "$IMG" --subnet-id "$SUB" --assign-public-ip true --boot-volume-size-in-gbs 50 \
          --ssh-authorized-keys-file "$WORK/key.pub" --user-data-file "$WORK/user-data.sh" \
          --query data.id --raw-output 2>&1); then
        ID=$(printf '%s' "$out" | grep -o 'ocid1\.instance[^" ]*' | head -1 || true)
        break
      fi
      if printf '%s' "$out" | grep -qiE 'capacity|TooManyRequests|LimitExceeded.*host'; then
        echo "$(date +%H:%M:%S) attempt $attempt in ${AD##*:}: no capacity yet"
      else
        echo "$out"; exit 1
      fi
    done
    [ -n "$ID" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || { echo "Still no capacity after $RETRY_MINUTES minutes; run again later."; exit 2; }
    sleep 60
  done
  rm -rf "$WORK"
fi

say "Waiting for the instance to run ($ID)"
STATE=""
for _ in $(seq 1 90); do
  STATE=$(val oci compute instance get --instance-id "$ID" --query 'data."lifecycle-state"' --raw-output)
  echo "$(date +%H:%M:%S) ${STATE:-unknown}"
  if [ "$STATE" = RUNNING ]; then break; fi
  case "$STATE" in TERMINAT*) echo "The instance was terminated."; exit 1 ;; esac
  sleep 10
done
IP=""
for _ in $(seq 1 30); do
  IP=$(val oci compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"' --raw-output)
  [ -n "$IP" ] && break
  sleep 10
done
echo "$IP" > ~/"$NAME-ip.txt"

say "Done"
echo "Public IP:  $IP"
echo "SSH:        ssh ubuntu@$IP"
echo "Console:    https://${IP//./-}.sslip.io/admin/   (ready about 5 minutes after first boot)"
