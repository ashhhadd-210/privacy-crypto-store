# Server hardening checklist

The client's VPS: Ubuntu 24.04.5 LTS, 4 vCPU, 8 GB RAM, 242 GB NVMe (UltaHost VDS).
Done and verified 28 Sep 2026. Every "verified" line was checked from outside the server or
after a reboot, not assumed from the command that set it.

## Access

- [x] **Key-only SSH.** `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
      `PermitRootLogin prohibit-password`, in `/etc/ssh/sshd_config.d/00-davmad-hardening.conf`.
      The provider's own `yes` lines in `/etc/ssh/sshd_config` (above the `Include`, so they won
      over ours) are commented out. Original saved as `/etc/ssh/sshd_config.bak-2026-09-28`.
      **Verified:** from outside, the server offers `publickey` only.
- [x] **Provider script that re-enabled passwords at boot, removed.**
      `goldimage-sshd-fix.service` (UltaHost image) rewrote every `PasswordAuthentication` and
      `PermitRootLogin` line to `yes` on every start. Unit file moved to
      `/root/provider-disabled/` and the unit **masked**. **Verified** across two reboots.
      Side effect to tell the client: UltaHost's panel "reset root password" will no longer give
      SSH password access. That is intended; the web console still works.
- [x] `MaxAuthTries 3`, `LoginGraceTime 30`, agent/TCP/X11 forwarding off.
- [x] The root password that was sent over chat no longer grants SSH access.
- [x] **Deploy user** (29 Sep): `deploy` has a single key restricted to one forced command,
      `sudo /usr/local/sbin/davmad-deploy`; sudo allows nothing else. CI holds that key.
- [ ] Our own admin access still uses root by key. Move it to a named sudo user at handover.
- [ ] Client to change the **UltaHost account** password (it controls the web console and
      billing, and was sent over chat on 22 Sep).

## Network

- [x] **Firewall (ufw)** on at boot: deny incoming, allow outgoing, SSH rate-limited (`LIMIT`).
      Nothing else is open.
- [x] **Containers unreachable from the internet.** Docker publishes ports around ufw's rules,
      so a `DOCKER-USER` rule in `/etc/ufw/after.rules` drops every new inbound connection to a
      container from `eth0`; replies to connections containers make still pass. Source:
      `ops/ufw-docker-user.rules`. **Verified** in `iptables -S DOCKER-USER`.
- [x] **443 open to Cloudflare's published IPv4 ranges only** (9 Oct, `go-public.sh`), above the
      DROP line. Verified: the server's IP answers nothing on 443 or 80 directly. Keep the list in
      step with `trusted_proxies` in the Caddyfile.
- [x] **Live on https://madlabsoil.net** behind Cloudflare, Full (strict), Cloudflare origin
      certificate (key generated on the server, never left it; valid to 2041).

## Patching and abuse

- [x] All packages upgraded; rebooted onto the new kernel (6.8.0-142).
- [x] **Automatic security updates** (`unattended-upgrades`, daily).
- [x] **fail2ban** on the SSH journal (5 failures in 10 minutes = 1 hour ban). It banned 3
      addresses from the log history the moment it started.
      Note for whoever maintains this: an SSH probe with `PreferredAuthentications=none` counts as
      a failure. Five of them from your own address will ban you for an hour.

## Secrets

- [x] App secrets generated **on the server** (`/etc/davmad-store/app.env`, `/opt/davmad/.env`,
      both `600 root`). They have never been on the developer's machine.
- [ ] Copy the encryption key into the client's password manager at handover. Losing it makes
      every stored order permanently unreadable.

## Software

- [x] Docker 29 and Compose v5 from Docker's own repository (signed), log size capped at
      5 × 20 MB per container, `live-restore` on.
- [x] **BTCPay Server** with a pruned mainnet Bitcoin node (`opt-save-storage-s`, about 50 GB),
      no built-in proxy, no Lightning, no container SSH access. Started 29 Sep. BTCPay publishes
      port 80, and it is **verified unreachable from the internet** (the DOCKER-USER rule).
      Node syncing: block 342,311 of 969,047 after 30 minutes.
- [x] **Store deployed** by the pipeline (29 Sep, `8083060`): app and database running and
      healthy, not reachable from outside until Caddy and Cloudflare are connected.
- [x] **Rollback exercised** (9 Oct): a deliberately broken release was rolled back automatically.
- [x] **Restore drill on the server** (9 Oct): backup opened by the reference `age` tool and
      restored; tables and migrations match.
- [x] **Nightly jobs active**: retention purge (03:30 UTC), payment reconcile + email outbox
      (every 5 min). Backup timer waits for the client's age key.
- [x] **BTCPay store set up** (9 Oct): admin (credentials in `/root/btcpay-admin.txt`, handed
      over and replaced by the client), store, invoices-only API key, webhook over the internal
      network. Node fully synced (block 970,624). **Wallet not connected**: needs the client's xpub.
