#!/usr/bin/env bash
# Restore drill: proves the newest backup can be opened and restored, without
# touching the live database. Run on the VPS with the client present, because
# it needs their secret key for a few seconds:
#
#   AGE_IDENTITY_FILE=/root/drill-key.txt bash restore-drill.sh
#   shred -u /root/drill-key.txt
#
# Restores into a throwaway PostgreSQL container, counts the tables and rows,
# and removes the container. Also opens the file with the reference `age` tool
# when it is installed, which proves our encryption matches the standard.
set -euo pipefail

DIR=/var/backups/davmad
latest=$(ls -1t "$DIR"/store-*.sql.age | head -1)
[ -n "${AGE_IDENTITY_FILE:-}" ] && [ -f "$AGE_IDENTITY_FILE" ] || { echo "set AGE_IDENTITY_FILE"; exit 1; }
echo "drill: restoring $(basename "$latest")"

if command -v age >/dev/null; then
  age -d -i "$AGE_IDENTITY_FILE" "$latest" | head -c 200 | grep -q 'PostgreSQL database dump' \
    && echo "drill: the reference age tool opens it: OK"
fi

name="davmad-drill-$$"
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=store -e POSTGRES_DB=store postgres:16-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do docker exec "$name" pg_isready -U store >/dev/null 2>&1 && break; sleep 1; done

# The app container runs as an unprivileged user and cannot read a root-only
# file, so it gets a readable copy inside a root-only directory, removed after.
keydir=$(mktemp -d); chmod 700 "$keydir"
install -m 0644 "$AGE_IDENTITY_FILE" "$keydir/key"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; shred -u "$keydir/key" 2>/dev/null; rm -rf "$keydir"' EXIT

cd /opt/davmad
docker compose run --rm -T --no-deps -v "$keydir/key:/drill-key:ro" -e AGE_IDENTITY_FILE=/drill-key \
  app node dist/scripts/age-encrypt.js --decrypt < "$latest" \
  | docker exec -i "$name" psql -q -U store -d store >/dev/null

docker exec "$name" psql -U store -d store -Atc \
  "select 'tables: ' || count(*) from information_schema.tables where table_schema='public';
   select 'orders: ' || count(*) from orders;
   select 'products: ' || count(*) from products;
   select 'migrations: ' || count(*) from schema_migrations;"
echo "drill: restore OK"
