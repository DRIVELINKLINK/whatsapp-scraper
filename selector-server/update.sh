#!/usr/bin/env bash
# Update the server to the latest code and show the collector log.
# Keeps the running version + the 2 previous ones (tags :prev1, :prev2); older versions are deleted automatically.
cd /opt/wa-selector && git pull -q --ff-only && cd selector-server || exit 1

# One-time alert settings (kept only on the server).
if ! grep -q '^NTFY_TOPIC=' .env; then
  echo "NTFY_TOPIC=wa-alerts-$(tr -dc 'a-z0-9' </dev/urandom | head -c 16)" >> .env
  NEW_TOPIC=1
fi
if ! grep -q '^QR_URL=' .env; then
  echo "QR_URL=http://$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}'):8080" >> .env
fi

# Before building: current → prev1, prev1 → prev2 (the old prev2 loses its name and is deleted below).
for img in $(docker compose config --images 2>/dev/null); do
  img=${img%:latest}
  docker image inspect "$img:prev1" >/dev/null 2>&1 && docker tag "$img:prev1" "$img:prev2"
  docker image inspect "$img:latest" >/dev/null 2>&1 && docker tag "$img:latest" "$img:prev1"
done

docker compose up -d --build

# Delete only versions that have no name any more (never the running one, never prev1/prev2),
# plus build leftovers older than a week.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true

sleep 20 && docker compose ps && docker compose logs --tail 30 collector worker
TOPIC=$(grep '^NTFY_TOPIC=' .env | cut -d= -f2)
echo
if [ -n "$NEW_TOPIC" ]; then
  echo "== התראות לטלפון =="
  echo "1. התקינו את האפליקציה ntfy (אנדרואיד / אייפון)"
  echo "2. לחצו + והקלידו את שם הערוץ:  $TOPIC"
  echo "   (שמרו את השם בסוד — מי שיודע אותו רואה את ההתראות)"
else
  echo "ערוץ ההתראות: $TOPIC"
fi
echo "גרסאות שמורות:"; docker images --format '  {{.Repository}}:{{.Tag}}  {{.CreatedSince}}  {{.Size}}' | grep -E 'selector-server' || true
