#!/usr/bin/env bash
# Deploys one release of the store. Installed on the VPS as
# /usr/local/sbin/davmad-deploy and run as root via sudo, by the `deploy` user,
# whose only SSH key can run this and nothing else.
#
# Reads a release on stdin: a tar holding image.tar (docker save of the app
# image), docker-compose.yml and Caddyfile. Then:
#   1. load the image, keep the running one as davmad-store:previous
#   2. install the compose file and Caddyfile from the release
#   3. apply database migrations with the new image
#   4. start the new app and wait for /readyz (app up, database reachable)
#   5. if it never gets ready, put the previous image back and fail
#
# Migrations are forward-only, so a rollback restores the previous code on the
# already-migrated schema. Every migration must keep the previous release
# working (add columns, never drop or rename in the same release).
set -euo pipefail

ROOT=/opt/davmad
IMAGE=davmad-store
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

exec 9>/run/davmad-deploy.lock
flock -n 9 || { log "another deploy is running"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -x -C "$work" --no-same-owner -f -
for f in image.tar docker-compose.yml Caddyfile; do
  [[ -f "$work/$f" ]] || { log "release is missing $f"; exit 1; }
done

loaded=$(docker load -i "$work/image.tar" | sed -n 's/^Loaded image: //p' | tail -1)
[[ "$loaded" == "$IMAGE":* ]] || { log "unexpected image in release: ${loaded:-none}"; exit 1; }
log "loaded $loaded"

had_previous=false
if docker image inspect "$IMAGE:current" >/dev/null 2>&1; then
  docker tag "$IMAGE:current" "$IMAGE:previous"
  had_previous=true
fi
docker tag "$loaded" "$IMAGE:current"

install -m 0644 "$work/docker-compose.yml" "$ROOT/docker-compose.yml"
install -m 0644 "$work/Caddyfile" "$ROOT/Caddyfile"
[[ -f "$work/davmad-backup.sh" ]] && install -m 0750 "$work/davmad-backup.sh" /usr/local/sbin/davmad-backup
cd "$ROOT"

ready() {
  docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

rollback() {
  log "rolling back: $1"
  if $had_previous; then
    docker tag "$IMAGE:previous" "$IMAGE:current"
    docker compose up -d --no-deps app
    log "previous release restored"
  fi
  exit 1
}

docker compose up -d --wait db
docker compose run --rm app node dist/scripts/migrate.js || rollback "migration failed"
docker compose up -d --no-deps --force-recreate app

for _ in $(seq 1 45); do
  if ready; then
    log "ready: $loaded"
    docker image prune -f --filter "label!=keep" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
rollback "new release never became ready"
