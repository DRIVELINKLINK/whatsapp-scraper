// Runs inside web.whatsapp.com (MAIN world). Reads WhatsApp's own data and hands it to relay.js.
(function () {
  if (window.__waHubMonitor) return;
  window.__waHubMonitor = true;

  const VERSION = "1.3.0";
  const SKIP_TYPES = new Set([
    "gp2", "notification", "notification_template", "e2e_notification", "protocol",
    "ciphertext", "call_log", "revoked", "debug", "broadcast_notification", "pinned_message",
    "reaction", "keep_in_chat", "unknown",
  ]);
  const TYPE_LABEL = {
    image: "📷 תמונה", video: "🎬 וידאו", ptt: "🎤 הקלטה", audio: "🎵 אודיו",
    document: "📄 מסמך", sticker: "סטיקר", location: "📍 מיקום", vcard: "👤 איש קשר",
    multi_vcard: "👥 אנשי קשר", poll_creation: "📊 סקר", event_creation: "📅 אירוע",
  };

  const post = (kind, payload) => window.postMessage({ __wahub: true, kind, payload }, location.origin);
  const log = (...a) => console.log("%c[WA Collector]", "color:#25d366;font-weight:bold", ...a);

  let C = null;
  const sent = new Set();

  const ser = (x) => (x ? x._serialized || String(x) : "");
  const msgId = (m) => (m.id && (m.id._serialized || (typeof m.id.toString === "function" && m.id.toString()))) || "";
  const isGroupId = (id) => id.endsWith("@g.us");

  function chatName(id) {
    try {
      const c = C.Chat.get(id);
      return (c && (c.name || c.formattedTitle || (c.groupMetadata && c.groupMetadata.subject))) || "";
    } catch (_) { return ""; }
  }

  function senderName(m, authorId) {
    if (m.id.fromMe) return "אני";
    try {
      const ct = C.Contact.get(authorId);
      const n = ct && (ct.name || ct.pushname || ct.verifiedName || ct.formattedName);
      if (n) return n;
    } catch (_) {}
    if (m.notifyName) return m.notifyName;
    return authorId.replace(/@.*$/, "");
  }

  // Sender's real phone number. Groups often identify senders by a hidden id (…@lid);
  // WhatsApp Web keeps the matching phone number, so we ask it. Never throws; null when unknown.
  let LidApi;
  function lidApi() {
    if (LidApi === undefined) {
      try { LidApi = (window.require && window.require("WAWebApiContact")) || null; } catch (_) { LidApi = null; }
    }
    return LidApi;
  }
  function phoneFromWid(w) {
    const s = ser(w);
    const mm = s.match(/^(\d{7,15})@(c\.us|s\.whatsapp\.net)$/);
    if (!mm) return null;
    const d = mm[1];
    return d.startsWith("972") ? "0" + d.slice(3) : "+" + d;
  }
  function senderPhone(m, authorId) {
    try {
      const direct = phoneFromWid(authorId);
      if (direct) return direct;
      if (!authorId.endsWith("@lid")) return null;
      const wid = m.author || m.from;
      const api = lidApi();
      if (api && typeof api.getPhoneNumber === "function") {
        const p = phoneFromWid(api.getPhoneNumber(wid));
        if (p) return p;
      }
      const ct = C.Contact.get(authorId);
      const p2 = ct && (phoneFromWid(ct.phoneNumber) || phoneFromWid(ct.id && ct.id.phoneNumber));
      if (p2) return p2;
      const chat = C.Chat.get(ser(m.id.remote));
      const parts = chat && chat.groupMetadata && chat.groupMetadata.participants;
      const part = parts && parts.get && parts.get(authorId);
      return (part && phoneFromWid(part.phoneNumber)) || null;
    } catch (_) {
      return null;
    }
  }

  function bodyOf(m) {
    const t = m.type || "chat";
    if (t === "chat") return m.body || "";
    if (t === "location") return TYPE_LABEL.location + (m.loc ? ": " + m.loc : "");
    if (t === "poll_creation") return TYPE_LABEL.poll_creation + ": " + (m.pollName || "");
    const label = TYPE_LABEL[t] || "[" + t + "]";
    const cap = m.caption || (t === "document" ? m.filename : "") || "";
    return cap ? label + ": " + cap : label;
  }

  function toRow(m) {
    if (!m || !m.id || !m.id.remote) return null;
    const gid = ser(m.id.remote);
    if (!isGroupId(gid)) return null;
    const type = m.type || "chat";
    if (SKIP_TYPES.has(type)) return null;
    const id = msgId(m);
    if (!id || id === "[object Object]") return null;
    const body = bodyOf(m);
    if (!body) return null;
    const authorId = ser(m.author) || ser(m.from) || gid;
    const name = senderName(m, authorId);
    return {
      id,
      group_id: gid,
      group_name: chatName(gid) || null,
      sender: name,
      sender_id: authorId,
      sender_name: name,
      sender_phone: m.id.fromMe ? null : senderPhone(m, authorId),
      body,
      type,
      from_me: !!m.id.fromMe,
      timestamp: new Date((m.t || Date.now() / 1000) * 1000).toISOString(),
    };
  }

  function sendMsgs(list) {
    const rows = [];
    for (const m of list) {
      const r = toRow(m);
      if (r && !sent.has(r.id)) { sent.add(r.id); rows.push(r); }
    }
    if (rows.length) post("messages", rows);
    return rows.length;
  }

  function groups() {
    return C.Chat.getModelsArray()
      .filter((c) => c.isGroup || (c.id && c.id.server === "g.us"))
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || c.formattedTitle || (c.groupMetadata && c.groupMetadata.subject) || "קבוצה",
        participants: (c.groupMetadata && c.groupMetadata.participants && c.groupMetadata.participants.length) || 0,
      }));
  }

  // Only send groups that are new or changed (name / participant count). Re-sending all of them every
  // 10 minutes rewrote ~200 rows each time and made every open app screen reload.
  const sentGroups = new Map();
  function syncGroups() {
    try {
      const g = groups();
      const changed = g.filter((x) => sentGroups.get(x.id) !== x.name + "|" + x.participants);
      if (changed.length) {
        post("groups", changed);
        for (const x of changed) sentGroups.set(x.id, x.name + "|" + x.participants);
      }
      return g.length;
    } catch (e) { log("groups error", e); return 0; }
  }

  // Safety net: anything that is in memory and newer than `sinceSec` gets (re)sent; the database ignores duplicates.
  function sweep(sinceSec) {
    try {
      const recent = C.Msg.getModelsArray().filter((m) => (m.t || 0) >= sinceSec);
      return sendMsgs(recent);
    } catch (e) { log("sweep error", e); return 0; }
  }

  function start() {
    const n = syncGroups();
    const backlog = sweep(Math.floor(Date.now() / 1000) - 24 * 3600);
    log("פועל ✅", n, "קבוצות,", backlog, "הודעות מה-24 שעות האחרונות נשלחו");

    C.Msg.on("add", (m) => {
      try {
        // Small delay so WhatsApp finishes filling in caption/sender info.
        setTimeout(() => sendMsgs([m]), 300);
      } catch (_) {}
    });

    let lastSweep = Math.floor(Date.now() / 1000);
    setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      sweep(lastSweep - 120);
      lastSweep = now;
    }, 60 * 1000);

    setInterval(syncGroups, 10 * 60 * 1000);

    const beat = () => post("heartbeat", { groups: groups().length, version: VERSION });
    beat();
    setInterval(beat, 60 * 1000);
  }

  function ready() {
    try {
      const col = window.require && window.require("WAWebCollections");
      if (col && col.Chat && col.Msg && col.Chat.getModelsArray().length > 0) { C = col; return true; }
    } catch (_) {}
    return false;
  }

  let tries = 0;
  const wait = setInterval(() => {
    if (ready()) { clearInterval(wait); start(); }
    else if (++tries % 30 === 0) log("ממתין ש-WhatsApp ייטען...");
  }, 2000);
})();
