const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── State ────────────────────────────────────
let state = {
  status: 'setup',   // setup | waiting_qr | authenticated | scraping | done | error
  groupName: '',
  qrCodeData: null,
  messageCount: 0,
  lastError: null,
  client: null,
};

// ── HTML helper ─────────────────────────────
function page(title, body, refresh = 0) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  ${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
  <style>
    *{box-sizing:border-box}
    body{font-family:Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f2f5}
    .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 2px 20px rgba(0,0,0,.1);max-width:500px;width:90%;text-align:center}
    h1{color:#25D366;margin-top:0}
    h2{color:#333}
    input[type=text]{width:100%;padding:12px;border:2px solid #ddd;border-radius:8px;font-size:1.1em;margin:10px 0 20px;text-align:right;direction:rtl}
    input[type=text]:focus{border-color:#25D366;outline:none}
    .btn{display:inline-block;padding:14px 28px;border:none;border-radius:8px;font-size:1em;cursor:pointer;text-decoration:none;margin:6px}
    .btn-green{background:#25D366;color:#fff}
    .btn-dark{background:#128C7E;color:#fff}
    .btn-gray{background:#eee;color:#555;font-size:.85em}
    pre{background:#f5f5f5;padding:12px;border-radius:8px;text-align:right;color:red;font-size:.85em;white-space:pre-wrap}
    .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:.8em;margin-bottom:12px}
    .badge-green{background:#e8f5e9;color:#2e7d32}
    .badge-orange{background:#fff3e0;color:#e65100}
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

// ── Routes ───────────────────────────────────

// 1. Setup — enter group name
app.get('/', (req, res) => {
  if (state.status === 'done') {
    return res.redirect('/done');
  }
  if (state.status !== 'setup') {
    return res.redirect('/status-page');
  }
  res.send(page('WhatsApp Scraper', `
    <h1>WhatsApp Scraper</h1>
    <h2>🔍 איזו קבוצה לשאוב?</h2>
    <form method="POST" action="/start">
      <input type="text" name="groupName" placeholder="שם הקבוצה (חלקי מספיק)" required autofocus>
      <button class="btn btn-green" type="submit">▶ התחל</button>
    </form>
  `));
});

// 2. Start scraping — receive group name
app.post('/start', (req, res) => {
  const groupName = (req.body.groupName || '').trim();
  if (!groupName) return res.redirect('/');
  if (state.status !== 'setup') return res.redirect('/status-page');

  state.groupName = groupName;
  state.status = 'waiting_qr';
  initClient();
  res.redirect('/status-page');
});

// 3. Status page
app.get('/status-page', (req, res) => {
  const { status, groupName, qrCodeData, messageCount, lastError } = state;
  let body = `<h1>WhatsApp Scraper</h1>
    <div class="badge badge-orange">קבוצה: ${groupName}</div><br>`;

  if (status === 'waiting_qr') {
    body += qrCodeData
      ? `<h2>📱 סרוק עם וואטסאפ</h2>
         <img src="${qrCodeData}" style="width:280px;height:280px;border:4px solid #25D366;border-radius:12px;"><br>
         <small style="color:#888">וואטסאפ → הגדרות → מכשירים מקושרים → קשר מכשיר</small>`
      : `<h2>⏳ מאתחל...</h2><p>רענון אוטומטי בעוד שניות</p>`;
    body += `<meta http-equiv="refresh" content="4">`;
  } else if (status === 'authenticated') {
    body += `<h2>✅ מחובר!</h2><p>⏳ מחפש קבוצה ושואב הודעות...</p>
             <meta http-equiv="refresh" content="3">`;
  } else if (status === 'scraping') {
    body += `<h2>⏳ שואב הודעות...</h2>
             <p>נמצאו עד כה: <strong>${messageCount}</strong> הודעות</p>
             <meta http-equiv="refresh" content="3">`;
  } else if (status === 'error') {
    body += `<h2>❌ שגיאה</h2><pre>${lastError}</pre>
             <a href="/reset" class="btn btn-gray">🔄 נסה שנית עם קבוצה אחרת</a>`;
  } else if (status === 'done') {
    return res.redirect('/done');
  }

  res.send(page('WhatsApp Scraper', body));
});

// 4. Done page
app.get('/done', (req, res) => {
  res.send(page('סיום!', `
    <h1>🎉 סיום!</h1>
    <div class="badge badge-green">קבוצה: ${state.groupName}</div>
    <p>נשמרו <strong>${state.messageCount}</strong> הודעות</p>
    <a href="/download/json" class="btn btn-green">⬇️ הורד JSON</a>
    <a href="/download/csv" class="btn btn-dark">⬇️ הורד CSV</a>
    <br><br>
    <a href="/reset" class="btn btn-gray">🔄 שאב קבוצה אחרת</a>
  `));
});

// 5. Downloads
app.get('/download/json', (req, res) => {
  const f = '/tmp/messages.json';
  fs.existsSync(f) ? res.download(f, 'messages.json') : res.status(404).send('קובץ לא נמצא');
});

app.get('/download/csv', (req, res) => {
  const f = '/tmp/messages.csv';
  fs.existsSync(f) ? res.download(f, 'messages.csv') : res.status(404).send('קובץ לא נמצא');
});

// 6. Reset — start over with new group
app.get('/reset', async (req, res) => {
  if (state.client) {
    try { await state.client.destroy(); } catch {}
    state.client = null;
  }
  state = { status: 'setup', groupName: '', qrCodeData: null, messageCount: 0, lastError: null, client: null };
  res.redirect('/');
});

// 7. JSON status (for monitoring)
app.get('/api/status', (req, res) => {
  res.json({ status: state.status, group: state.groupName, messageCount: state.messageCount });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 שרת רץ על פורט ${PORT}`));

// ── WhatsApp Client ──────────────────────────
function initClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'],
    },
  });
  state.client = client;

  client.on('qr', async (qr) => {
    console.log('📱 QR חדש');
    state.qrCodeData = await qrcode.toDataURL(qr);
    state.status = 'waiting_qr';
  });

  client.on('authenticated', () => {
    console.log('✅ אומת');
    state.status = 'authenticated';
    state.qrCodeData = null;
  });

  client.on('ready', async () => {
    console.log('🚀 מחובר — שואב');
    state.status = 'scraping';
    try {
      const chats = await client.getChats();
      const group = chats.find(c => c.isGroup && c.name.includes(state.groupName));

      if (!group) {
        const names = chats.filter(c => c.isGroup).map(c => c.name).join('\n');
        state.lastError = `לא נמצאה קבוצה בשם "${state.groupName}".\n\nקבוצות זמינות:\n${names}`;
        state.status = 'error';
        return;
      }

      console.log(`📋 קבוצה: ${group.name}`);
      const messages = await group.fetchMessages({ limit: 1000000 });
      state.messageCount = messages.length;
      console.log(`📨 ${messages.length} הודעות`);

      const parsed = messages.map(m => ({
        id: m.id.id,
        timestamp: new Date(m.timestamp * 1000).toISOString(),
        from: m.author || m.from,
        fromName: m._data?.notifyName || '',
        body: m.body,
        type: m.type,
        hasMedia: m.hasMedia,
      }));

      fs.writeFileSync('/tmp/messages.json', JSON.stringify(parsed, null, 2));
      const rows = parsed.map(m =>
        `"${m.timestamp}","${m.from}","${(m.fromName||'').replace(/"/g,'""')}","${m.type}","${(m.body||'').replace(/"/g,'""').replace(/\n/g,' ')}"`
      );
      fs.writeFileSync('/tmp/messages.csv', '﻿' + 'timestamp,from,fromName,type,body\n' + rows.join('\n'));

      state.status = 'done';
      console.log('✅ סיום');
    } catch (err) {
      state.lastError = err.message;
      state.status = 'error';
      console.error('❌', err.message);
    }
  });

  client.on('auth_failure', msg => {
    state.lastError = 'שגיאת אימות: ' + msg;
    state.status = 'error';
  });

  client.initialize();
}
