# WhatsApp Selector — שרת איסוף

מריץ על שרת את **אותו תוסף Chrome** שרץ היום במחשב (`extension/`, גרסה 1.3.0), בתוך Chromium עם מסך וירטואלי.
החיבור לוואטסאפ נשמר בתיקייה `data/` בשרת, כך שסורקים QR פעם אחת בלבד.
ההודעות נכתבות ל-Supabase של הסלקטור בדיוק כמו מהמחשב; מזהה ההודעה של וואטסאפ מונע כפילויות, ולכן אפשר להריץ במקביל לתוסף במחשב.

## התקנה (Ubuntu 24.04, ‏4GB)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DRIVELINKLINK/whatsapp-scraper/selector-server/selector-server/install.sh)
```

ואז לפתוח `http://<IP>:8080` ולסרוק את הקוד.

## פקודות

| מה | פקודה (בתוך `/opt/wa-selector/selector-server`) |
| --- | --- |
| יומן | `docker compose logs -f` |
| הפעלה מחדש | `docker compose restart` |
| עדכון קוד | `git pull && docker compose up -d --build` |
| ניתוק וסריקה מחדש | `docker compose down && rm -rf data/profile && docker compose up -d` |

הגרסה בטבלת `wa_status` תופיע כ-`1.3.0-server` כשהשרת הוא ששולח את הדופק.
