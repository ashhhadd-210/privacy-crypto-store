#!/usr/bin/env bash
#
# Local development database, without Docker.
#
# The dev machine has no Docker and no WSL2, so PostgreSQL 16 runs from the
# portable EDB binaries with its data directory inside the repo at .pgdata/
# (gitignored). Nothing here is used on the VPS; production runs Postgres in
# a container from docker-compose.yml.
#
#   scripts/dev-db.sh init      first time: create the cluster, the role and the database
#   scripts/dev-db.sh start     start the server on 127.0.0.1:5432
#   scripts/dev-db.sh stop
#   scripts/dev-db.sh status
#   scripts/dev-db.sh psql      open a shell on the store database
#
# PG_BIN overrides where the binaries live. Default is ~/pgsql-16/bin, which
# is where the EDB zip was unpacked on 22 Sep.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

# The binaries are native Windows programs. Paths handed to them must be
# Windows paths (C:/...), not the /c/... form Git Bash uses internally.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

PG_BIN="${PG_BIN:-$HOME/pgsql-16/bin}"
PGDATA="$(winpath "$APP/.pgdata")"
PGPORT="${PGPORT:-5432}"
LOG="$PGDATA/server.log"

# Matches DATABASE_URL in .env.example. Local only; the VPS uses its own.
DB_NAME=store
DB_USER=store
DB_PASS=store

die() { echo "dev-db: $*" >&2; exit 1; }

[ -x "$PG_BIN/pg_ctl" ] || [ -x "$PG_BIN/pg_ctl.exe" ] \
  || die "PostgreSQL binaries not found at $PG_BIN (set PG_BIN, or unpack the EDB zip there)"

pgctl()  { "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT" "$@"; }
psql_su(){ "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

is_running() { pgctl status >/dev/null 2>&1; }

case "${1:-}" in
  init)
    [ -d "$PGDATA" ] && die ".pgdata already exists; remove it first if you want a fresh cluster"
    # Trust auth on loopback only: this is a throwaway dev cluster holding
    # placeholder data, and the encryption layer is what protects real PII.
    "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
    echo "cluster created at $PGDATA"
    pgctl -l "$LOG" -w start >/dev/null
    psql_su -q <<SQL
CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
SQL
    echo "role '$DB_USER' and database '$DB_NAME' created"
    echo "server running on 127.0.0.1:$PGPORT"
    echo
    echo "next:  npm run migrate && npm run seed"
    ;;
  start)
    if is_running; then echo "already running on port $PGPORT"; exit 0; fi
    [ -d "$PGDATA" ] || die "no cluster yet; run: scripts/dev-db.sh init"
    pgctl -l "$LOG" -w start >/dev/null
    echo "running on 127.0.0.1:$PGPORT"
    ;;
  stop)
    is_running || { echo "not running"; exit 0; }
    pgctl -m fast -w stop >/dev/null
    echo "stopped"
    ;;
  status)
    if is_running; then
      echo "running on 127.0.0.1:$PGPORT"
      "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -Atc "select version()"
    else
      echo "not running"
    fi
    ;;
  psql)
    shift
    exec "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" "$@"
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
