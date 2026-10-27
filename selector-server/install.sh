#!/usr/bin/env bash
# WhatsApp Selector — server install (Ubuntu 24.04). Run: bash <(curl -fsSL <raw url of this file>)
set -euo pipefail
DIR=/opt/wa-selector
BRANCH=selector-server

echo "== מתקין Docker (אם חסר) =="
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y git >/dev/null

echo "== מוריד את הקוד =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only
else git clone -b "$BRANCH" --depth 1 https://github.com/DRIVELINKLINK/whatsapp-scraper "$DIR"; fi
cd "$DIR/selector-server"

if [ ! -f .env ]; then
  echo "== הגדרות (נשמרות רק בשרת) =="
  read -rp "מפתח Supabase של הסלקטור (sb_publishable_...): " KEY
  read -rsp "סיסמה לדף סריקת ה-QR: " PASS; echo
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
