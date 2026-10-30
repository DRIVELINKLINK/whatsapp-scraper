// WhatsApp Selector — watchdog. Checks the collector, the worker, new messages, memory and disk once a minute
// and sends a push notification (ntfy app) when something breaks, a reminder every hour while it stays broken,
// and a "back to normal" message when it recovers. No dependencies, no Lovable credits (one tiny read a minute).
import fs from "node:fs";

const SB_URL = process.env.SUPABASE_URL || "https://xxbstgdhtlalremiftwf.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "";
const TOPIC = process.env.NTFY_TOPIC || "";
const NTFY = process.env.NTFY_SERVER || "https://ntfy.sh";
const COLLECTOR = process.env.COLLECTOR_URL || "http://collector:8080/status";
const QR_PASSWORD = process.env.QR_PASSWORD || "";
const QR_URL = process.env.QR_URL || "";
const EVERY = 60_000;
const REMIND = 60 * 60_000;
const MIN = 60_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function notify(title, message, priority = 4) {
  log("ALERT", title, "—", message);
  if (!TOPIC) return;
  await fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: TOPIC, title, message, priority, tags: [priority >= 4 ? "warning" : "white_check_mark"] }), signal: AbortSignal.timeout(15_000) })
    .catch((e) => log("ntfy failed:", String(e)));
}

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return res.json();
}
const ageMin = (iso) => (iso ? (Date.now() - Date.parse(iso)) / MIN : Infinity);

/** Quiet hours (03:00–07:00 Israel) allow longer gaps between messages. */
function messageGapLimit() {
  const h = new Date().getHours();
  return h >= 3 && h < 7 ? 40 : 15;
}

// One problem per key: { since, alertedAt, text }.
const problems = new Map();
/** bad = current text of the problem or null; graceMin = how long it must last before alerting. */
async function check(key, bad, graceMin = 0) {
  const now = Date.now();
  const cur = problems.get(key);
  if (!bad) {
    if (cur?.alertedAt) await notify("✅ חזר לפעול", `${cur.title} — תקין שוב (אחרי ${Math.round((now - cur.since) / MIN)} דק׳).`, 3);
    problems.delete(key);
    return;
  }
  const p = cur ?? { since: now, alertedAt: 0, title: bad.title };
  p.title = bad.title;
  problems.set(key, p);
  if (now - p.since < graceMin * MIN) return;
  if (!p.alertedAt || now - p.alertedAt >= REMIND) {
    await notify(`⚠️ ${bad.title}`, bad.text + (p.alertedAt ? ` (עדיין, כבר ${Math.round((now - p.since) / MIN)} דק׳)` : ""), 5);
    p.alertedAt = now;
  }
}

function memInfo() {
  const text = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] || 0);
  return { totalMb: kb("MemTotal") / 1024, availMb: kb("MemAvailable") / 1024, swapUsedMb: (kb("SwapTotal") - kb("SwapFree")) / 1024 };
}
function diskFreeGb() {
  const s = fs.statfsSync("/");
  return (s.bavail * s.bsize) / 1024 ** 3;
}

async function tick() {
  // 1. Collector (Chrome + WhatsApp Web)
  let col = null;
  try {
    const res = await fetch(COLLECTOR, { headers: { Authorization: "Basic " + Buffer.from("monitor:" + QR_PASSWORD).toString("base64") }, signal: AbortSignal.timeout(10_000) });
    col = res.ok ? await res.json() : null;
  } catch { col = null; }
  await check("collector-down", col ? null : { title: "אוסף ההודעות לא עונה", text: "הקונטיינר של כרום/וואטסאפ לא מגיב. הוא אמור לעלות לבד; אם לא — הריצו את פקודת העדכון." }, 3);
  await check("whatsapp-qr", col?.status === "qr" ? { title: "וואטסאפ התנתק — צריך לסרוק QR", text: `פתחו את דף ה-QR ${QR_URL} וסרקו מהטלפון: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר.` } : null, 1);
  await check("whatsapp-not-connected", col && col.status !== "connected" && col.status !== "qr" ? { title: "וואטסאפ לא מחובר", text: `מצב: ${col.status} ${col.detail || ""}`.trim() } : null, 10);

  // 2. Database: worker + extension heartbeats and the newest message
  let status = null, newest = null;
  try {
    status = await sb("wa_status?select=id,last_heartbeat,pending");
    newest = (await sb("wa_messages?select=created_at&order=created_at.desc&limit=1"))[0]?.created_at ?? null;
  } catch (e) { log("db read failed:", String(e)); }
  await check("db", status ? null : { title: "אין גישה למסד הנתונים", text: "השרת לא מצליח לקרוא מהסלקטור (לבאבל Cloud). ייתכן שהענן מושבת — בדקו קרדיטים." }, 5);
  if (status) {
    const worker = status.find((r) => r.id === "worker");
    const ext = status.find((r) => r.id === "main");
    await check("worker", ageMin(worker?.last_heartbeat) > 3 ? { title: "השרת ששולח לדרייבלינק לא פועל", text: `אין סימן חיים כבר ${Math.round(ageMin(worker?.last_heartbeat))} דק׳.` } : null);
    await check("queue", (worker?.pending ?? 0) > 20 ? { title: "תור השליחה תקוע", text: `${worker.pending} נסיעות ממתינות לשליחה.` } : null, 10);
    await check("extension", col?.status === "connected" && ageMin(ext?.last_heartbeat) > 5 ? { title: "התוסף באוסף לא מדווח", text: `וואטסאפ מחובר אבל התוסף שקט כבר ${Math.round(ageMin(ext?.last_heartbeat))} דק׳.` } : null, 2);
    const gap = ageMin(newest), limit = messageGapLimit();
    await check("messages", newest && gap > limit ? { title: "לא נכנסות הודעות", text: `ההודעה האחרונה נכנסה לפני ${Math.round(gap)} דק׳.` } : null);
  }

  // 3. Server memory and disk
  const mem = memInfo();
  await check("memory", mem.availMb < 400 ? { title: "הזיכרון בשרת כמעט מלא", text: `פנוי ${Math.round(mem.availMb)}MB מתוך ${Math.round(mem.totalMb)}MB, זיכרון חירום בשימוש ${Math.round(mem.swapUsedMb)}MB.` } : null, 5);
  const disk = diskFreeGb();
  await check("disk", disk < 5 ? { title: "הדיסק בשרת כמעט מלא", text: `נשארו ${disk.toFixed(1)}GB פנויים.` } : null);
}

log("monitor started", TOPIC ? `→ ntfy topic set` : "(NTFY_TOPIC missing — alerts only in this log)");
await notify("🟢 ההתראות פועלות", `השרת בודק כל דקה: וואטסאפ, אוסף ההודעות, השליחה לדרייבלינק, הודעות נכנסות, זיכרון ודיסק. זיכרון: ${Math.round(memInfo().totalMb)}MB, דיסק פנוי: ${diskFreeGb().toFixed(0)}GB.`, 3);
for (;;) {
  try { await tick(); } catch (e) { log("tick failed:", String(e)); }
  await new Promise((r) => setTimeout(r, EVERY));
}
