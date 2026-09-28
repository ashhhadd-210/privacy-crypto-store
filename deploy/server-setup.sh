#!/usr/bin/env bash
# One-time preparation of the VPS for deployments. Run as root. Safe to re-run:
# it never overwrites an existing secrets file.
#
#   ssh ... 'bash -s' < deploy/server-setup.sh
#
# Creates:
#   /etc/davmad-store/app.env   app secrets, 600 root. Generated here, on the
#                               server, so the encryption key exists in one
#                               place only. Back it up to the client's password
#                               manager: losing it makes every order unreadable.
#   /opt/davmad/.env            compose settings (database password, site name)
#   deploy user                 can run /usr/local/sbin/davmad-deploy via sudo
#                               and nothing else
set -euo pipefail

key() { openssl rand -base64 32; }

install -d -m 0755 /opt/davmad
install -d -m 0700 /etc/davmad-store

if [[ ! -f /etc/davmad-store/app.env ]]; then
  dbpass=$(openssl rand -hex 24)
  umask 077
  cat > /etc/davmad-store/app.env <<EOF
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://store.invalid
DATABASE_URL=postgres://store:${dbpass}@db:5432/store
ENCRYPTION_KEY=$(key)
BLIND_INDEX_KEY=$(key)
SESSION_SECRET=$(key)
DEFAULT_RETENTION_DAYS=30
EOF
  cat > /opt/davmad/.env <<EOF
POSTGRES_PASSWORD=${dbpass}
# The real domain replaces this when Cloudflare is connected. Caddy is not
# started until then.
SITE_DOMAIN=store.invalid
EOF
  chmod 600 /etc/davmad-store/app.env /opt/davmad/.env
  echo "secrets generated"
else
  echo "secrets already present, left untouched"
fi

id deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

cat > /etc/sudoers.d/davmad-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/local/sbin/davmad-deploy
EOF
chmod 440 /etc/sudoers.d/davmad-deploy
visudo -cf /etc/sudoers.d/davmad-deploy >/dev/null

echo "server ready for deployments"
