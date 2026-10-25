const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// הגדרות — שנה כאן לפני דיפלוי
// =============================================
const GROUP_NAME = process.env.GROUP_NAME || 'שם הקבוצה שלך';
const OUTPUT_FILE = '/tmp/messages.json';
// =============================================

let qrCodeData = null;
let status = 'waiting_qr'; // waiting_qr | authenticated | scraping | done | error
let messageCount = 0;
let lastError = null;

// ── Web UI ──────────────────────────────────
app.get('/', async (req, res) => {
  let body = '';

  if (status === 'waiting_qr') {
    const qrImg = qrCodeData
      ? `<img src="${qrCodeData}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;">`
      : `<p style="font-size:1.2em;">⏳ ממתין לקוד QR... רענן בעוד כמה שניות</p>`;
    body = `
      <h2>📱 סרוק את הקוד עם וואטסאפ</h2>
      ${qrImg}
      <p style="color:#888;">וואטסאפ → הגדרות → מכשירים מקושרים → קשר מכשיר</p>
      <script>setTimeout(()=>location.reload(), 5000)</script>
    `;
  } else if (status === 'authenticated') {
    body = `<h2>✅ מחובר!</h2><p>⏳ מחפש קבוצה ושואב הודעות...</p><script>setTimeout(()=>location.reload(), 3000)</script>`;
  } else if (status === 'scraping') {
    body = `<h2>⏳ שואב הודעות...</h2><p>נמצאו עד כה: <strong>${messageCount}</strong> הודעות</p><script>setTimeout(()=>location.reload(), 3000)</script>`;
  } else if (status === 'done') {
    body = `
      <h2>🎉 סיום!</h2>
      <p>נשמרו <strong>${messageCount}</strong> הודעות</p>
      <a href="/download/json" style="display:inline-block;margin:10px;padding:12px 24px;background:#25D366;color:white;text-decoration:none;border-radius:8px;">⬇️ הורד JSON</a>
      <a href="/download/csv" style="display:inline-block;margin:10px;padding:12px 24px;background:#128C7E;color:white;text-decoration:none;border-radius:8px;">⬇️ הורד CSV</a>
      <br><br><a href="/restart" style="color:#888;font-size:0.9em;">🔄 שאיבה מחדש</a>
    `;
  } else if (status === 'error') {
    body = `<h2>❌ שגיאה</h2><pre style="color:red;">${lastError}</pre><a href="/restart">נסה שוב</a>`;
  }

  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Scraper</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 500px; margin: 60px auto; text-align: center; background: #f0f2f5; }
    div.card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 2px 16px rgba(0,0,0,.1); }
    h1 { color: #25D366; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp Scraper</h1>
    <p style="color:#888;">קבוצה: <strong>${GROUP_NAME}</strong></p>
    ${body}
  </div>
</body>
</html>`);
});

app.get('/download/json', (req, res) => {
  if (fs.existsSync(OUTPUT_FILE)) {
    res.download(OUTPUT_FILE, 'messages.json');
  } else {
    res.status(404).send('קובץ לא נמצא');
  }
});

app.get('/download/csv', (req, res) => {
  const csvFile = OUTPUT_FILE.replace('.json', '.csv');
  if (fs.existsSync(csvFile)) {
    res.download(csvFile, 'messages.csv');
  } else {
    res.status(404).send('קובץ לא נמצא');
  }
});

app.get('/restart', (req, res) => {
  res.redirect('/');
  setTimeout(() => process.exit(0), 500); // Railway יאתחל אוטומטית
});

app.get('/status', (req, res) => {
  res.json({ status, messageCount, group: GROUP_NAME });
});

app.listen(PORT, () => {
  console.log(`🌐 שרת רץ על פורט ${PORT}`);
});

// ── WhatsApp Client ──────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  },
});

client.on('qr', async (qr) => {
  console.log('📱 QR קוד חדש — פתח את הכתובת בדפדפן לסריקה');
  qrCodeData = await qrcode.toDataURL(qr);
  status = 'waiting_qr';
});

client.on('authenticated', () => {
  console.log('✅ אומת בהצלחה');
  status = 'authenticated';
  qrCodeData = null;
});

client.on('ready', async () => {
  console.log('🚀 מחובר — מתחיל שאיבה');
  status = 'scraping';

  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name.includes(GROUP_NAME));

    if (!group) {
      const groups = chats.filter(c => c.isGroup).map(c => c.name).join(', ');
      lastError = `לא נמצאה קבוצה בשם "${GROUP_NAME}".\nקבוצות זמינות: ${groups}`;
      status = 'error';
      console.error(lastError);
      return;
    }

    console.log(`📋 קבוצה: ${group.name} — שואב הודעות...`);
    const messages = await group.fetchMessages({ limit: 1000000 });
    messageCount = messages.length;
    console.log(`📨 ${messageCount} הודעות`);

    const parsed = messages.map(msg => ({
      id: msg.id.id,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      from: msg.author || msg.from,
      fromName: msg._data?.notifyName || '',
      body: msg.body,
      type: msg.type,
      hasMedia: msg.hasMedia,
    }));

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(parsed, null, 2), 'utf-8');

    const csvFile = OUTPUT_FILE.replace('.json', '.csv');
    const rows = parsed.map(m =>
      `"${m.timestamp}","${m.from}","${(m.fromName||'').replace(/"/g,'""')}","${m.type}","${(m.body||'').replace(/"/g,'""').replace(/\n/g,' ')}"`
    );
    fs.writeFileSync(csvFile, '﻿' + 'timestamp,from,fromName,type,body\n' + rows.join('\n'), 'utf-8');

    status = 'done';
    console.log('✅ סיום — הורד מהדפדפן');
  } catch (err) {
    lastError = err.message;
    status = 'error';
    console.error('❌', err.message);
  }
});

client.on('auth_failure', msg => {
  lastError = 'שגיאת אימות: ' + msg;
  status = 'error';
});

client.initialize();
