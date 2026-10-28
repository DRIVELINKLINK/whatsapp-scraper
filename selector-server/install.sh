#!/usr/bin/env bash
# WhatsApp Selector — server install (Ubuntu 24.04). Run: bash <(curl -fsSL <raw url of this file>)
set -euo pipefail
DIR=/opt/wa-selector
BRANCH=selector-server

echo "== מתקין Docker (אם חסר) =="
apt-get update -qq && apt-get install -y -qq git curl >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# 2GB swap as a safety net for Chromium (only once)
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile || true
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "== מוריד את הקוד =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only
else git clone -b "$BRANCH" --depth 1 https://github.com/DRIVELINKLINK/whatsapp-scraper "$DIR"; fi
cd "$DIR/selector-server"

if [ ! -f .env ]; then
  echo "== הגדרות (נשמרות רק בשרת) =="
  read -rp "מפתח Supabase של הסלקטור (sb_publishable_...): " KEY
  read -rp "סיסמה לדף סריקת ה-QR (Enter = ליצור אוטומטית): " PASS
  KEY=$(printf '%s' "$KEY" | grep -o 'sb_publishable_[A-Za-z0-9_-]*' | head -1 || true)   # ignore paste garbage
  PASS=$(printf '%s' "$PASS" | sed -e 's/\x1b\[20[01]~//g' -e 's/\^\[\[20[01]~//g')
  case "$KEY" in sb_publishable_*) ;; *) echo "המפתח לא נראה תקין ($KEY). הריצו שוב."; exit 1;; esac
  if [ -z "$PASS" ]; then PASS="wa$( (tr -dc 'A-Za-z0-9' </dev/urandom | head -c 10) || true)"; fi
  echo "סיסמת דף ה-QR: $PASS   (רשמו אותה)"
  printf 'SUPABASE_KEY=%s\nQR_PASSWORD=%s\n' "$KEY" "$PASS" > .env
  chmod 600 .env
fi

echo "== בונה ומפעיל (כמה דקות בפעם הראשונה) =="
docker compose up -d --build
IP=$(curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "מוכן. פתחו בדפדפן: http://$IP:8080  (משתמש: כל שם, סיסמה: מה שהגדרתם)"
echo "סרקו את הקוד מהטלפון: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר"
echo "יומן: cd $DIR/selector-server && docker compose logs -f"
