#!/usr/bin/env bash
# Adds the DriveLink connection to .env (once) and starts the transfer worker.
set -euo pipefail
cd /opt/wa-selector && git pull -q --ff-only && cd selector-server
grep -q '^DRIVELINK_INTAKE_URL=' .env || echo 'DRIVELINK_INTAKE_URL=https://drivelink.dev/api/external-ride' >> .env
if ! grep -q '^DRIVELINK_INTAKE_KEY=' .env; then
  read -rp "מפתח DriveLink (dlx_...): " K
  K=$(printf '%s' "$K" | grep -o 'dlx_[A-Za-z0-9_-]*' | head -1 || true)
  [ -n "$K" ] || { echo "המפתח לא תקין"; exit 1; }
  echo "DRIVELINK_INTAKE_KEY=$K" >> .env
fi
docker compose up -d --build
sleep 15
docker compose ps
docker compose logs --tail 15 worker
