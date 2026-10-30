// WhatsApp Selector — cloud collector.
// Runs the SAME Chrome extension as on the PC (../extension) inside Chromium on a server,
// keeps the WhatsApp Web session on disk, and serves a password-protected page for scanning the QR once.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const DATA = process.env.DATA_DIR || "/data";
const PROFILE = path.join(DATA, "profile");
const EXT_SRC = path.join(__dirname, "..", "extension");
const EXT = path.join(DATA, "extension-build");
const QR_FILE = path.join(DATA, "qr.png");
const PORT = Number(process.env.QR_PORT || 8080);
const QR_PASSWORD = process.env.QR_PASSWORD || "";
const KEY = process.env.SUPABASE_KEY || "";

let state = { status: "starting", since: new Date().toISOString(), detail: "" };
const setState = (status, detail = "") => {
  if (state.status !== status) console.log(new Date().toISOString(), "status:", status, detail);
  state = { status, since: state.status === status ? state.since : new Date().toISOString(), detail };
};

function buildExtension() {
  if (!KEY) throw new Error("SUPABASE_KEY is missing in .env");
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });
  for (const f of fs.readdirSync(EXT_SRC)) {
    if (!fs.statSync(path.join(EXT_SRC, f)).isFile()) continue;
    let text = fs.readFileSync(path.join(EXT_SRC, f), "utf8");
    if (f === "bg.js") text = text.replace("__SUPABASE_KEY__", KEY);
    if (f === "main.js") text = text.replace(/const VERSION = "([^"]+)";/, 'const VERSION = "$1-server";');
    fs.writeFileSync(path.join(EXT, f), text);
  }
}

function startQrServer() {
  http
    .createServer((req, res) => {
      const auth = req.headers.authorization || "";
      const given = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
      if (!QR_PASSWORD || given !== QR_PASSWORD) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WhatsApp Selector"' });
        return res.end("Unauthorized");
      }
      const pathname = (req.url || "/").split("?")[0];
      if (pathname === "/qr.png" && fs.existsSync(QR_FILE)) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        return fs.createReadStream(QR_FILE).pipe(res);
      }
      if (pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(state));
      }
      const label = { starting: "מתחיל…", qr: "סרקו את הקוד: וואטסאפ בטלפון ← מכשירים מקושרים ← קישור מכשיר", connected: "מחובר ✅ האיסוף פועל", loading: "טוען את WhatsApp Web…", error: "שגיאה — מנסה שוב" }[state.status] || state.status;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>WhatsApp Selector — שרת</title><body style="font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px;text-align:center"><h1 style="font-size:22px">WhatsApp Selector — שרת איסוף</h1><p style="font-size:18px">${label}</p><p style="color:#666;font-size:13px">מאז ${state.since} ${state.detail || ""}</p>${state.status === "qr" ? `<img src="/qr.png?t=${Date.now()}" style="max-width:100%;border:1px solid #ddd">` : ""}</body></html>`);
    })
    .listen(PORT, () => console.log("QR page on port", PORT));
}

let context = null;
// Nightly restart of Chrome (default 04:00 Israel time) so its memory does not creep up over days.
// The WhatsApp session stays on disk (no new QR), and on start the extension re-sends the last 24h, so nothing is lost.
const RESTART_HOUR = Number(process.env.RESTART_HOUR ?? 4);
async function run() {
  const startedAt = Date.now();
  if (context) { await context.close().catch(() => {}); context = null; }
  buildExtension();
  fs.mkdirSync(PROFILE, { recursive: true });
  context = await chromium.launchPersistentContext(PROFILE, {
    // Real browser window inside a virtual display (xvfb). HEADLESS=1 is only for local tests.
    headless: process.env.HEADLESS === "1",
    ...(process.env.HEADLESS === "1" ? { channel: "chromium" } : {}),
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--disable-dev-shm-usage"],
  });
  let dead = "";
  context.on("close", () => { dead = "browser closed"; });
  const page = context.pages()[0] || (await context.newPage());
  page.on("crash", () => { dead = "page crashed"; });
  page.on("console", (m) => { if (m.text().includes("WA Collector")) console.log("[page]", m.text()); });
  await page.goto(process.env.WA_URL || "https://web.whatsapp.com", { waitUntil: "domcontentloaded", timeout: 120000 });
  setState("loading");

  let lastConnected = 0;
  for (;;) {
    if (dead || page.isClosed()) throw new Error(dead || "page closed");
    if (RESTART_HOUR >= 0 && new Date().getHours() === RESTART_HOUR && Date.now() - startedAt > 2 * 3600_000) {
      console.log(new Date().toISOString(), "nightly restart of Chrome");
      setState("loading", "הפעלה לילית של כרום");
      return;
    }
    const connected = await page.locator("#pane-side").count().catch(() => 0);
    if (connected) {
      lastConnected = Date.now();
      if (state.status !== "connected") { setState("connected"); fs.rmSync(QR_FILE, { force: true }); }
    } else {
      const qr = await page.locator("canvas").count().catch(() => 0);
      if (qr) { setState("qr"); await page.screenshot({ path: QR_FILE }).catch(() => {}); }
      else if (state.status !== "connected" || Date.now() - lastConnected > 120000) setState("loading");
      // Stuck without chats for 10 minutes after having been connected → reload WhatsApp Web.
      if (lastConnected && Date.now() - lastConnected > 600000) { lastConnected = Date.now(); await page.reload({ timeout: 120000 }).catch(() => {}); }
    }
    await new Promise((r) => setTimeout(r, Number(process.env.POLL_MS || 5000)));
  }
}

startQrServer();
(async function loop() {
  for (;;) {
    try { await run(); } catch (e) { setState("error", String(e && e.message || e).slice(0, 200)); console.error(e); }
    await new Promise((r) => setTimeout(r, 15000)); // restart the browser after a failure / nightly restart
  }
})();
