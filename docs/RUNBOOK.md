# Runbook — davmad privacy store

For whoever operates the server. Plain commands, in the order you will need them. Everything
here was written against the real setup; anything not yet exercised on the live server says so.

## Layout

| What | Where |
|---|---|
| Store (app, database, web server) | `/opt/davmad` (`docker-compose.yml`, `Caddyfile`, `.env`, `certs/`) |
| Store secrets | `/etc/davmad-store/app.env` (600 root). **Holds the encryption key.** |
| BTCPay + Bitcoin node | `/opt/btcpay/btcpayserver-docker` (its own compose stack, network `generated_default`) |
| Backups | `/var/backups/davmad/store-*.sql.age` (+ optional client remote) |
| Deploy script | `/usr/local/sbin/davmad-deploy` (run only via the `deploy` user's forced command) |
| Timers | `davmad-purge` (03:30 UTC), `davmad-backup` (02:45 UTC), `davmad-reconcile` (every 5 min) |

Sign in: `ssh -i <your key> root@<server>`. Password logins are disabled. `systemctl list-timers 'davmad-*'` shows when each job last ran and runs next.

## Everyday

**Deploy.** Push to `main`. GitHub Actions tests, smoke-tests the production image, then deploys
it. Watch it in the repository's Actions tab. A release that fails its health check is rolled
back automatically and the run goes red.

**Roll back by hand** (if a release is healthy but wrong):
```
cd /opt/davmad
docker tag davmad-store:previous davmad-store:current
docker compose up -d --no-deps app
```
Migrations are forward-only and each keeps the previous release working, so this is safe.

**Logs.** `docker compose -f /opt/davmad/docker-compose.yml logs --since 1h app`. They never
contain customer details by design; if you ever see one, that is a bug.

**Is everything up?** `docker ps` (all healthy), and from the server:
`docker compose -f /opt/davmad/docker-compose.yml exec app node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>console.log(r.status))"`

## Payments

- Invoices are created by the store over the internal network (`BTCPAY_URL`); customers pay at
  `https://pay.<domain>` (`BTCPAY_PUBLIC_URL`).
- If BTCPay is down, orders are kept and customers see "Pay now" to try again.
- A lost webhook is caught within five minutes by `davmad-reconcile`.
- Check the node: `docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data getblockchaininfo`
  (`initialblockdownload: false` once synced).
- **Update BTCPay:** `cd /opt/btcpay/btcpayserver-docker && . ./helpers.sh && btcpay-update.sh`.
  Run when BTCPay announces a release. The node keeps its data.
- Wrong-amount payments show on the admin dashboard. Refunds are sent by the store owner from
  their own wallet, then marked in the admin.

## Backups and restore

- Nightly at 02:45 UTC, locked to the client's age public key, kept for the retention period
  (the same number of days as customer data), then deleted. Copied to `BACKUP_REMOTE` if set.
- Never enabled without the key: the timer stays off until `EXPORT_AGE_RECIPIENT` is in
  `app.env`, so a readable backup can never be written.
- **Restore drill** (needs the client's secret key, briefly): put it in `/root/drill-key.txt`,
  run `AGE_IDENTITY_FILE=/root/drill-key.txt bash /opt/davmad/restore-drill.sh`, then
  `shred -u /root/drill-key.txt`. It restores into a throwaway database and counts the tables.
  Done locally on 9 Oct (every table matched); **to repeat on the server before go-live.**
- **Real restore** (after a disaster): same decryption into the live database:
  `d=$(mktemp -d); install -m 0644 /root/key.txt $d/k; docker compose run --rm -T --no-deps -v $d/k:/k:ro -e AGE_IDENTITY_FILE=/k app node dist/scripts/age-encrypt.js --decrypt < BACKUP | docker compose exec -T db psql -U store -d store; shred -u $d/k; rm -rf $d`
  (the key copy must be readable by the container's unprivileged user; it lives only in a root-only temporary directory)
  You also need `/etc/davmad-store/app.env` from the client's password manager: **a backup
  without the encryption key is unreadable** by design.

## Keys and rotation

| Secret | Lives in | Rotate how | Effect |
|---|---|---|---|
| `ENCRYPTION_KEY` | `app.env` + client's password manager | Do not, without a re-encryption migration | Losing it makes every stored order unreadable |
| `BLIND_INDEX_KEY` | same | Do not, without re-indexing | Guest lookup and sign-in stop matching |
| `SESSION_SECRET` | `app.env` | Replace, restart app | Everyone signed out; harmless |
| Database password | `app.env` + `/opt/davmad/.env` | Change in both and in Postgres, restart | — |
| BTCPay API key / webhook secret | `app.env` + BTCPay | Create new in BTCPay, update `app.env`, restart, delete old | — |
| Deploy key | GitHub secret `DEPLOY_SSH_KEY` + `/home/deploy/.ssh/authorized_keys` | Generate new pair on the server, replace both | — |
| Admin password | Admin → Change password | Any time | Other sessions signed out |
| Client export/backup key | Client, offline | Client makes a new one; update `EXPORT_AGE_RECIPIENT` | Old backups need the old key |

## Go-live (once, when the domain exists)

1. Client adds the domain to Cloudflare. DNS: `A @` and `A pay`, both pointing at the server,
   both proxied. SSL/TLS: **Full (strict)**; Always Use HTTPS.
2. Cloudflare → SSL/TLS → Origin Server → create a certificate for `<domain>, *.<domain>`. Save
   it on the server as `/opt/davmad/certs/origin.pem` and `origin-key.pem`.
3. `bash /opt/davmad/go-public.sh <domain>`. It sets the public addresses, opens 443 to
   Cloudflare's ranges only, starts the web server, and checks it from outside.
4. In BTCPay (`https://pay.<domain>`): create the admin account, create the store, connect the
   client's **store wallet xpub** (watch-only), create an API key (invoices only) and a webhook
   to `https://<domain>/webhooks/btcpay` with a secret. Put `BTCPAY_URL=http://generated_btcpayserver_1:49392`,
   `BTCPAY_STORE_ID`, `BTCPAY_API_KEY`, `BTCPAY_WEBHOOK_SECRET` in `app.env`; restart the app.
5. Email provider (client's account): domain verified, SPF, DKIM and DMARC records in
   Cloudflare; `SMTP_*` and `MAIL_FROM` in `app.env`; install the mailer (`npm i nodemailer`,
   commit, push); place an order and check the email arrives.
6. Client's age public key into `app.env` as `EXPORT_AGE_RECIPIENT`; re-run
   `deploy/server-setup.sh` to enable the backup timer; run the restore drill.
7. Security round part 2 (`deliverables/security_report.md`), rollback drill.
8. Cloudflare Pro at launch: OWASP managed ruleset on; WAF rule limiting `/admin*` (Cloudflare
   Access with email OTP, or the client's IP); rate-limit rule on `/checkout`, `/order`,
   `/account/login`; webhook path exempt from bot challenges.
9. Tiny real order with the client watching: pay, see it settle, stock change, email arrive,
   order appear in the admin. Then the store is live.

**Admin logins.** Create an admin, or reset a forgotten password (prints a new one once; also
clears a lockout):
```
cd /opt/davmad && docker compose exec -T app node dist/scripts/create-admin.js someone@example.com
```
The login page allows 5 attempts per 10 minutes per connection (the "429 Too many requests"
page), and an account locks for 15 minutes after 5 wrong passwords. Waiting, or the command above,
clears both.

**Security scans.** Actions → "Security scan" runs weekly and on demand: Trivy over the production
image and an OWASP ZAP scan of the signed-in admin, against a throwaway copy of the store. Reports
are attached to each run. A red run means a fixable HIGH/CRITICAL vulnerability: rebuild (push any
commit) to pick up base-image fixes, or update the dependency.

**Cloudflare (Pro).** Security → Security rules: Cloudflare Managed + OWASP Core rulesets; custom
rule blocking `/webhooks/btcpay` from outside (BTCPay calls the app inside the server); rate limit of
20 POSTs a minute per IP on `/admin/login`, `/checkout*`, `/order`. Custom rule "Checkout human check": Managed Challenge on `GET /checkout` (the "Verify you are human" box, client request 14 Oct). Super Bot Fight Mode: definitely automated = Allow, JavaScript detections **off** (they inject an inline script the CSP blocks), verified bots on. If the admin ever gets a
Cloudflare "blocked" page while saving, add a skip rule for paths starting with `/admin`. SSL/TLS:
Full (strict), Always Use HTTPS, minimum TLS 1.2.

## If something breaks

| Symptom | Look at |
|---|---|
| Site down | `docker ps`; `docker compose logs caddy app`; Cloudflare status |
| Orders stuck "awaiting payment" after paying | `journalctl -u davmad-reconcile`; BTCPay → Store → Webhooks → deliveries |
| Emails not arriving | Admin order page "Emails to the customer"; `journalctl -u davmad-reconcile` (shows failures) |
| Deploy red in GitHub | The failing step's log; the server is still on the previous release |
| Disk filling | `df -h`; `docker system df`; the node is pruned to about 50 GB |
| Locked out of SSH | UltaHost web console (client's account) |
| "Too many requests" on the admin login | Wait 10 minutes; or reset with `create-admin.js` (above) |
| Cloudflare "you have been blocked" | Security → Events in Cloudflare shows which rule; add a skip rule for that path |
