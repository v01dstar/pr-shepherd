#!/usr/bin/env bash
# Runs inside the instabox box, from a freshly pushed release directory (scripts/deploy-instabox.sh calls it).
# Idempotent: Postgres on /data, a build of this release, the release swapped in, the systemd unit installed.
# Usage: instabox-provision.sh <release-dir> <live-dir>
set -euo pipefail

RELEASE="${1:?release dir}" LIVE="${2:?live dir}"
USER_NAME=$(id -un)
DATA=/data/shepherd
PG_DATA=/data/pg
DB=pr_shepherd

mkdir -p "$DATA"

echo "==> postgres"
if ! command -v pg_lsclusters >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql jq >/dev/null
  # The package's default cluster lives on the root disk; ours lives on /data.
  PG_VER=$(pg_lsclusters -h | awk 'NR==1 {print $1}')
  sudo pg_dropcluster --stop "$PG_VER" main
fi
PG_VER=$(ls /usr/lib/postgresql | sort -n | tail -1)
if ! pg_lsclusters -h | grep -q "$PG_DATA"; then
  sudo install -d -o postgres -g postgres -m 700 "$PG_DATA"
  sudo pg_createcluster --datadir="$PG_DATA" "$PG_VER" main -- --auth-local=peer --auth-host=scram-sha-256
  # Unix socket only: nothing on the box's network reaches the database.
  sudo pg_conftool "$PG_VER" main set listen_addresses ''
fi
sudo systemctl enable --now "postgresql@$PG_VER-main"
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '$USER_NAME'" | grep -q 1 || sudo -u postgres createuser "$USER_NAME"
sudo -u postgres psql -tAc "select 1 from pg_database where datname = '$DB'" | grep -q 1 || sudo -u postgres createdb -O "$USER_NAME" "$DB"

echo "==> build"
cd "$RELEASE"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm prune --omit=dev --no-audit --no-fund --loglevel=error

echo "==> install"
sudo systemctl stop pr-shepherd 2>/dev/null || true
rm -rf "$LIVE.old"
[[ -d "$LIVE" ]] && mv "$LIVE" "$LIVE.old"
mv "$RELEASE" "$LIVE"
rm -rf "$LIVE.old"
chmod +x "$LIVE/scripts/instabox-run.sh"

sudo tee /etc/systemd/system/pr-shepherd.service >/dev/null <<UNIT
[Unit]
Description=pr-shepherd
After=network-online.target postgresql@$PG_VER-main.service instabox-guest-agent.service
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$LIVE
ExecStart=$LIVE/scripts/instabox-run.sh
Restart=always
RestartSec=5
# The bot interrupts its runs and marks them on SIGTERM within 30 seconds (DESIGN §11).
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
