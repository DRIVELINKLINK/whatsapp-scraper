// Background worker: the only part that talks to the database (not subject to WhatsApp's page restrictions).
const URL = "https://xxbstgdhtlalremiftwf.supabase.co/rest/v1";
const KEY = "__SUPABASE_KEY__";
const HEADERS = { apikey: KEY, "Content-Type": "application/json" };
const QUEUE_KEY = "pendingMessages";
const MAX_QUEUE = 5000;

class HttpError extends Error {
  constructor(status, text) { super(status + " " + text); this.status = status; }
}

async function post(path, body, prefer) {
  const r = await fetch(URL + path, {
    method: "POST",
    headers: { ...HEADERS, Prefer: prefer + ",return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new HttpError(r.status, (await r.text()).slice(0, 300));
}

const valid = (row) => row && typeof row.id === "string" && row.id && typeof row.group_id === "string";

async function getQueue() {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  return (o[QUEUE_KEY] || []).filter(valid);
}

let lastError = null;
async function reportError(where, e) {
  lastError = where + ": " + String(e && e.message ? e.message : e).slice(0, 300);
  console.warn("[WA Collector]", lastError);
  await chrome.storage.local.set({ lastError, lastErrorAt: Date.now() });
}

const sendRows = (rows) => post("/wa_messages?on_conflict=id", rows, "resolution=ignore-duplicates");

let flushing = null;
function flush() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  let q = await getQueue();
  while (q.length) {
    const batch = q.slice(0, 200);
    try {
      await sendRows(batch);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500 || e.status === 429) {
        await reportError("network", e); // temporary problem: keep the queue and retry later
        return;
      }
      // A row the database rejects must not block everything behind it: send one by one, drop the bad ones.
      await reportError("rejected", e);
      for (const row of batch) {
        try { await sendRows([row]); } catch (e2) {
          if (!(e2 instanceof HttpError) || e2.status >= 500 || e2.status === 429) { await reportError("network", e2); return; }
        }
      }
    }
    const current = await getQueue();
    const sentIds = new Set(batch.map((r) => r.id));
    q = current.filter((r) => !sentIds.has(r.id));
    await chrome.storage.local.set({ [QUEUE_KEY]: q, lastOk: Date.now() });
    lastError = null;
  }
}

async function enqueue(rows) {
  const q = await getQueue();
  const merged = q.concat(rows.filter(valid)).slice(-MAX_QUEUE);
  await chrome.storage.local.set({ [QUEUE_KEY]: merged });
  await flush();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.kind === "messages" && Array.isArray(msg.payload)) {
        await enqueue(msg.payload);
      } else if (msg.kind === "groups" && Array.isArray(msg.payload) && msg.payload.length) {
        const now = new Date().toISOString();
        const rows = msg.payload.map((g) => ({ ...g, last_seen: now }));
        for (let i = 0; i < rows.length; i += 200) {
          await post("/wa_groups?on_conflict=id", rows.slice(i, i + 200), "resolution=merge-duplicates");
        }
      } else if (msg.kind === "heartbeat") {
        await flush(); // retry anything still waiting
        const pending = (await getQueue()).length;
        await post(
          "/wa_status?on_conflict=id",
          [{
            id: "main",
            last_heartbeat: new Date().toISOString(),
            groups: msg.payload.groups,
            version: msg.payload.version,
            pending,
            last_error: lastError,
          }],
          "resolution=merge-duplicates",
        );
      }
    } catch (e) {
      await reportError(msg.kind, e);
    }
    reply({ ok: true });
  })();
  return true;
});

// Retry pending messages even if WhatsApp is quiet.
chrome.alarms.create("retry", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => flush());
