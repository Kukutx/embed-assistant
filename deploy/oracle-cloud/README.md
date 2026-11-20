# Oracle Cloud (Always Free)

Creates an Arm VM (`VM.Standard.A1.Flex`, 1 OCPU and 6 GB by default, inside the
Always Free allowance) and installs the server on it with
[`single-server/install.sh`](../single-server/).

1. Open **Cloud Shell** in the Oracle Cloud console (the `>_` icon at the top).
2. Run, with the SSH public key that should be able to log in:

   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/embed-assistant/main/deploy/oracle-cloud/create-vm.sh) "ssh-ed25519 AAAA..."
   ```

   It creates a VCN with ports 22, 80 and 443 open, launches the VM and retries
   every minute while the region reports "Out of host capacity" (up to 3 hours,
   `RETRY_MINUTES`). It prints the public IP at the end.
3. About five minutes later the console is at `https://<ip-with-dashes>.sslip.io/admin/`.
   The first admin key is in `/opt/embed-assistant/first-run.txt` on the VM.
4. Add model keys: copy a file with `KEY=value` lines to the VM and run the
   installer again (it keeps the database and merges the keys):

   ```bash
   scp keys.env ubuntu@<ip>:/tmp/keys.env
   ssh ubuntu@<ip> 'sudo KEYS_FILE=/tmp/keys.env bash /root/install.sh && rm /tmp/keys.env'
   ```

Settings: `NAME`, `OCPUS`, `MEMORY_GB`, `RETRY_MINUTES`, `COMPARTMENT_ID`
(default: the tenancy root). Running it again reuses the network and does
nothing if the instance exists.
