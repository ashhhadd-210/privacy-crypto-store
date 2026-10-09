#!/usr/bin/env bash
# One-time BTCPay setup for the store, run on the VPS as root. Idempotent:
# anything already done is left alone.
#
#   bash btcpay-bootstrap.sh
#
# Creates, through BTCPay's own API (reached from this server only):
#   - the first BTCPay user (becomes its admin); password saved to
#     /root/btcpay-admin.txt for the handover, where the client replaces it
#   - a store, "Store", USD, invoices expire after 60 minutes
#   - an API key that can only create, read and invalidate that store's invoices
#   - a webhook to the store app over the internal Docker network, with a secret
# and writes BTCPAY_URL / STORE_ID / API_KEY / WEBHOOK_SECRET into app.env.
#
# Not done here, because it needs the client: connecting the store's wallet
# (their xpub). Until then BTCPay cannot issue an invoice, and checkout shows
# the "pay later" message instead of failing.
set -euo pipefail

API=http://127.0.0.1:80
ENV=/etc/davmad-store/app.env
CRED=/root/btcpay-admin.txt
APP_HOOK=http://davmad-app-1:3000/webhooks/btcpay

j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
set_kv() { if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }

if [[ ! -s $CRED ]]; then
  email="admin@store.invalid"
  pass=$(openssl rand -base64 24 | tr -d '/+=')
  code=$(curl -s -o /tmp/u.json -w '%{http_code}' -X POST "$API/api/v1/users" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pass\",\"isAdministrator\":true}")
  [[ $code == 200 || $code == 201 ]] || { echo "could not create the BTCPay admin (HTTP $code): $(head -c 300 /tmp/u.json)"; exit 1; }
  umask 077; printf 'BTCPay admin\nemail: %s\npassword: %s\n' "$email" "$pass" > "$CRED"
  echo "BTCPay admin created; credentials in $CRED"
fi
email=$(sed -n 's/^email: //p' "$CRED"); pass=$(sed -n 's/^password: //p' "$CRED")
auth=(-u "$email:$pass")

store=$(grep -oP '^BTCPAY_STORE_ID=\K.+' "$ENV" || true)
if [[ -z $store ]]; then
  store=$(curl -sf "${auth[@]}" -X POST "$API/api/v1/stores" -H 'content-type: application/json' \
    -d '{"name":"Store","defaultCurrency":"USD","invoiceExpiration":3600,"speedPolicy":"MediumSpeed","receipt":{"enabled":false}}' | j "d['id']")
  set_kv BTCPAY_STORE_ID "$store"
  echo "store created: $store"
fi

if ! grep -q '^BTCPAY_API_KEY=.\+' "$ENV"; then
  key=$(curl -sf "${auth[@]}" -X POST "$API/api/v1/api-keys" -H 'content-type: application/json' \
    -d "{\"label\":\"store app (invoices only)\",\"permissions\":[\"btcpay.store.cancreateinvoice:$store\",\"btcpay.store.canviewinvoices:$store\",\"btcpay.store.canmodifyinvoices:$store\"]}" | j "d['apiKey']")
  set_kv BTCPAY_API_KEY "$key"
  echo "API key created (invoices only, this store only)"
fi

if ! grep -q '^BTCPAY_WEBHOOK_SECRET=.\+' "$ENV"; then
  secret=$(openssl rand -hex 32)
  curl -sf "${auth[@]}" -X POST "$API/api/v1/stores/$store/webhooks" -H 'content-type: application/json' \
    -d "{\"url\":\"$APP_HOOK\",\"enabled\":true,\"automaticRedelivery\":true,\"secret\":\"$secret\",\"authorizedEvents\":{\"everything\":true}}" >/dev/null
  set_kv BTCPAY_WEBHOOK_SECRET "$secret"
  echo "webhook created -> $APP_HOOK"
fi

set_kv BTCPAY_URL "http://generated_btcpayserver_1:49392"
chmod 600 "$ENV"
cd /opt/davmad && docker compose up -d --no-deps --force-recreate app >/dev/null
echo "app restarted with BTCPay settings"

wallet=$(curl -s "${auth[@]}" "$API/api/v1/stores/$store/payment-methods" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any(m.get('enabled') for m in d) if isinstance(d,list) else False)" 2>/dev/null || echo False)
echo "wallet connected: $wallet (connect the client's store xpub to enable invoices)"
