#!/usr/bin/env bash
# Puts the store on its domain, behind Cloudflare. Run once on the VPS, as root,
# after the domain is in the client's Cloudflare account:
#
#   bash go-public.sh shop.example.com
#
# Before running:
#   1. Cloudflare DNS: A records for the domain and for pay.<domain>, both
#      pointing at this server, both PROXIED (orange cloud).
#   2. Cloudflare SSL/TLS: mode "Full (strict)"; Always Use HTTPS on.
#   3. Cloudflare origin certificate for "<domain>, *.<domain>" saved as
#      /opt/davmad/certs/origin.pem and origin-key.pem (chmod 600 the key).
#
# What it does: points the store and BTCPay at their public addresses, opens
# port 443 to Cloudflare's published ranges only (never to the whole
# internet), starts the web server, and checks the result from outside.
set -euo pipefail

DOMAIN="${1:?usage: go-public.sh <domain>}"
PAY="pay.${DOMAIN}"
ROOT=/opt/davmad
[[ -s $ROOT/certs/origin.pem && -s $ROOT/certs/origin-key.pem ]] || { echo "origin certificate missing in $ROOT/certs"; exit 1; }
chmod 600 "$ROOT/certs/origin-key.pem"

set_kv() { # file key value
  if grep -q "^$2=" "$1"; then sed -i "s#^$2=.*#$2=$3#" "$1"; else echo "$2=$3" >> "$1"; fi
}
set_kv "$ROOT/.env" SITE_DOMAIN "$DOMAIN"
set_kv "$ROOT/.env" BTCPAY_DOMAIN "$PAY"
set_kv /etc/davmad-store/app.env PUBLIC_URL "https://$DOMAIN"
set_kv /etc/davmad-store/app.env BTCPAY_PUBLIC_URL "https://$PAY"
echo "public addresses set: https://$DOMAIN and https://$PAY"

# BTCPay must know its public address for its own pages and links.
( cd /opt/btcpay/btcpayserver-docker && . ./helpers.sh >/dev/null 2>&1; changedomain.sh "$PAY" >/dev/null ) \
  && echo "BTCPay now answers as $PAY"

# Port 443 from Cloudflare only. The list is Cloudflare's published ranges; it
# must match trusted_proxies in the Caddyfile. Inserted above the DROP rule in
# the DOCKER-USER chain (Docker publishes ports around ufw's own rules).
CF4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
rules=""
for net in $CF4; do rules+="-A DOCKER-USER -i eth0 -s $net -p tcp -m conntrack --ctorigdstport 443 -j RETURN"$'\n'; done
if ! grep -q 'davmad: cloudflare 443' /etc/ufw/after.rules; then
  cp -a /etc/ufw/after.rules "/etc/ufw/after.rules.bak-$(date +%F)"
  python3 - "$rules" <<'PY'
import sys
rules = sys.argv[1]
p = '/etc/ufw/after.rules'
s = open(p).read()
anchor = '-A DOCKER-USER -i eth0 -j DROP'
assert anchor in s, 'DOCKER-USER block not found'
s = s.replace(anchor, '# davmad: cloudflare 443\n' + rules + anchor, 1)
open(p, 'w').write(s)
PY
  ufw reload >/dev/null
  systemctl restart docker
fi
echo "443 open to Cloudflare's ranges only"

cd "$ROOT"
docker compose up -d --force-recreate app caddy
sleep 8
for host in "$DOMAIN" "$PAY"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/" || true)
  echo "https://$host/ -> $code (through Cloudflare)"
done
ip=$(curl -s -4 https://ifconfig.co || true)
direct=$(curl -s -k -o /dev/null -m 6 -w '%{http_code}' --resolve "$DOMAIN:443:$ip" "https://$DOMAIN/" || true)
echo "direct to this server's IP -> ${direct:-no answer} (want: no answer)"
echo "next: run the security check (see docs/RUNBOOK.md, Go-live) and place the test order"
