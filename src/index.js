import http from "node:http";
import QRCode from "qrcode";
import pino from "pino";
import { config } from "./config.js";
import { MessageQueue } from "./queue.js";
import { Account } from "./account.js";

const log = pino({ level: config.logLevel });
const queue = new MessageQueue(log);
const accounts = new Map(config.accounts.map((n) => [n, new Account(n, queue, log)]));

const html = (title, body, refresh) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${title}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f0f2f5;margin:0;padding:24px;color:#111}
.card{background:#fff;border-radius:14px;padding:24px;max-width:560px;margin:0 auto 16px;box-shadow:0 1px 8px #0001}
h1{color:#128C7E;font-size:22px;margin:0 0 12px}.ok{color:#1a7f37}.bad{color:#b42318}img{width:280px;height:280px}
table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-bottom:1px solid #eee}a{color:#128C7E}</style></head>
<body>${body}</body></html>`;

const STATE_HE = {
  starting: "מתחיל...", connecting: "מתחבר...", qr: "ממתין לסריקת קוד", connected: "מחובר ✅", logged_out: "נותק מהטלפון — צריך לסרוק מחדש",
};

function authorized(url) {
  return !config.adminToken || url.searchParams.get("token") === config.adminToken;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };

  if (url.pathname === "/health") {
    return send(200, "application/json", JSON.stringify({ ok: true, queue: { pending: queue.pending, ...queue.stats } }));
  }
  if (!authorized(url)) return send(401, "text/plain; charset=utf-8", "חסר קוד גישה");
  const token = encodeURIComponent(url.searchParams.get("token") || "");

  if (url.pathname === "/") {
    const rows = [...accounts.values()].map((a) => {
      const i = a.info();
      const link = i.state === "qr" || i.state === "logged_out" ? ` — <a href="/qr/${i.account}?token=${token}">סרוק קוד</a>` : "";
      return `<tr><td><b>${i.account}</b></td><td class="${i.state === "connected" ? "ok" : "bad"}">${STATE_HE[i.state] || i.state}${link}</td>
        <td>${i.groups} קבוצות</td><td>${i.received} הודעות</td></tr>`;
    }).join("");
    const q = queue.stats;
    return send(200, "text/html; charset=utf-8", html("WA Collector", `<div class="card"><h1>WA Collector — מצב השרת</h1>
      <table>${rows}</table></div><div class="card">נכתבו למסד הנתונים: <b>${q.written}</b> · ממתינות: <b>${queue.pending}</b>
      ${q.lastError ? `<div class="bad">שגיאה אחרונה: ${q.lastError}</div>` : ""}</div>`, 10));
  }

  const m = url.pathname.match(/^\/qr\/([\w-]+)$/);
  if (m) {
    const a = accounts.get(m[1]);
    if (!a) return send(404, "text/plain; charset=utf-8", "אין חשבון כזה");
    if (a.state === "connected") {
      return send(200, "text/html; charset=utf-8", html("מחובר", `<div class="card"><h1 class="ok">✅ המספר מחובר</h1>
        <p>אפשר לסגור את הדף. <a href="/?token=${token}">למצב השרת</a></p></div>`));
    }
    if (!a.qr) {
      return send(200, "text/html; charset=utf-8", html("ממתין", `<div class="card"><h1>מכין קוד...</h1><p>הדף יתרענן לבד.</p></div>`, 3));
    }
    const img = await QRCode.toDataURL(a.qr, { width: 280, margin: 1 });
    return send(200, "text/html; charset=utf-8", html("סריקת קוד", `<div class="card"><h1>חיבור מספר WhatsApp</h1>
      <img src="${img}" alt="QR"><ol><li>פתח את WhatsApp בטלפון</li><li>הגדרות ← מכשירים מקושרים ← קישור מכשיר</li>
      <li>סרוק את הקוד</li></ol><p>הקוד מתחלף כל כמה שניות; הדף מתרענן לבד.</p></div>`, 15));
  }
  send(404, "text/plain; charset=utf-8", "לא נמצא");
});

server.listen(config.port, "0.0.0.0", () => log.info({ port: config.port, accounts: config.accounts }, "server listening"));

for (const a of accounts.values()) a.start().catch((e) => log.error({ err: e.message, account: a.name }, "start failed"));

setInterval(() => {
  for (const a of accounts.values()) a.heartbeat().catch((e) => log.warn({ err: e.message }, "heartbeat failed"));
}, config.heartbeatMs);

setInterval(() => {
  for (const a of accounts.values()) if (a.state === "connected") a.syncGroups().catch(() => {});
}, config.groupsSyncMs);

async function shutdown(sig) {
  log.info({ sig }, "shutting down");
  for (const a of accounts.values()) await a.stop();
  await queue.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandled rejection"));
