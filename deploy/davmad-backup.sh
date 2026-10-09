#!/usr/bin/env bash
# Nightly encrypted backup of the store database. Installed on the VPS as
# /usr/local/sbin/davmad-backup and run by davmad-backup.timer.
#
#   - pg_dump streams straight into the age encryptor: the readable dump never
#     touches the disk.
#   - Locked to the client's age public key. The server cannot read its own
#     backups; the client's offline secret key can.
#   - Kept for the retention period and no longer: a backup must not keep
#     customer details the store itself has already deleted.
#   - If BACKUP_REMOTE is set in /opt/davmad/.env (an rclone remote in the
#     client's name, e.g. "client-b2:store-backups"), each file is copied there
#     and pruned there too. Without it, backups live only on this server,
#     which protects against mistakes, not against losing the server.
set -euo pipefail

ROOT=/opt/davmad
DIR=/var/backups/davmad
cd "$ROOT"
set -a; . "$ROOT/.env"; set +a
mkdir -p "$DIR"; chmod 700 "$DIR"

days=$(docker compose exec -T db psql -U store -d store -Atc "select coalesce((select value::text::int from settings where key='retention_days'), 30)")
file="$DIR/store-$(date -u +%Y%m%d-%H%M).sql.age"

docker compose exec -T db pg_dump -U store -d store --no-owner --clean --if-exists \
  | docker compose run --rm -T --no-deps app node dist/scripts/age-encrypt.js > "$file.part"
[ -s "$file.part" ] || { echo "backup: empty output, keeping the previous backups"; rm -f "$file.part"; exit 1; }
head -c 21 "$file.part" | grep -q '^age-encryption.org/v1' || { echo "backup: output is not an age file"; rm -f "$file.part"; exit 1; }
mv "$file.part" "$file"
chmod 600 "$file"

find "$DIR" -name 'store-*.sql.age' -mtime "+$days" -delete
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$file" "$BACKUP_REMOTE"
  rclone delete --min-age "${days}d" "$BACKUP_REMOTE"
fi
echo "backup: $(basename "$file") $(stat -c %s "$file") bytes; keeping ${days} days; $(ls "$DIR" | wc -l) on disk"
