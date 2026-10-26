import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "baileys";
import { config } from "./config.js";
import { upsert } from "./db.js";
import { toRow } from "./extract.js";

/** One linked WhatsApp number. Keeps itself connected and feeds every group message into the queue. */
export class Account {
  constructor(name, queue, logger) {
    this.name = name;
    this.queue = queue;
    this.log = logger.child({ account: name });
    this.authDir = path.join(config.dataDir, "auth", name);
    this.state = "starting"; // starting | qr | connecting | connected | logged_out
    this.qr = null;
    this.groups = new Map(); // jid -> { name, participants }
    this.received = 0;
    this.lastMessageAt = null;
    this.retry = 0;
    this.sock = null;
    this.stopped = false;
  }

  async start() {
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* fall back to the library default */ }

    this.state = "connecting";
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu("WA Collector"),
      logger: this.log.child({ module: "baileys" }, { level: "warn" }),
      markOnlineOnConnect: false, // stay invisible; don't affect "last seen" or notifications on the phone
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => true, // receive messages missed while offline
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        this.qr = u.qr;
        this.state = "qr";
        this.log.info("waiting for QR scan");
      }
      if (u.connection === "open") {
        this.state = "connected";
        this.qr = null;
        this.retry = 0;
        this.log.info("connected");
        this.syncGroups().catch((e) => this.log.warn({ err: e.message }, "group sync failed"));
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.state = "logged_out";
          this.log.warn("logged out from the phone; a new QR scan is needed");
          fs.rmSync(this.authDir, { recursive: true, force: true });
        } else {
          this.state = "connecting";
        }
        if (this.stopped) return;
        const delay = Math.min(60_000, 2_000 * 2 ** this.retry++);
        this.log.info({ code, delay }, "connection closed, reconnecting");
        setTimeout(() => this.start().catch((e) => this.log.error({ err: e.message }, "restart failed")), delay);
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => this.handle(messages));
    sock.ev.on("messaging-history.set", ({ messages }) => this.handle(messages || []));

    sock.ev.on("groups.upsert", (list) => this.rememberGroups(list));
    sock.ev.on("groups.update", (list) => this.rememberGroups(list.filter((g) => g.subject)));
  }

  handle(messages) {
    for (const m of messages) {
      const gid = m.key?.remoteJid;
      const row = toRow(m, { account: this.name, groupName: this.groups.get(gid)?.name });
      if (!row) continue;
      this.queue.push(row);
      this.received++;
      this.lastMessageAt = new Date().toISOString();
    }
  }

  rememberGroups(list) {
    const rows = [];
    const now = new Date().toISOString();
    for (const g of list) {
      if (!g.id) continue;
      const prev = this.groups.get(g.id) || {};
      const name = g.subject || prev.name || "קבוצה";
      const participants = g.participants?.length ?? prev.participants ?? 0;
      this.groups.set(g.id, { name, participants });
      rows.push({ id: g.id, name, participants, account: this.name, last_seen: now });
    }
    if (rows.length) {
      (async () => {
        for (let i = 0; i < rows.length; i += 200) await upsert("wa_groups", rows.slice(i, i + 200));
      })().catch((e) => this.log.warn({ err: e.message }, "saving groups failed"));
    }
  }

  async syncGroups() {
    const all = await this.sock.groupFetchAllParticipating();
    this.rememberGroups(Object.values(all));
    this.log.info({ groups: this.groups.size }, "groups synced");
  }

  async heartbeat() {
    await upsert("wa_status", [{
      id: this.name,
      last_heartbeat: new Date().toISOString(),
      groups: this.groups.size,
      version: `server:${this.state}`,
      pending: this.queue.pending,
      last_error: this.queue.stats.lastError,
    }]);
  }

  info() {
    return {
      account: this.name,
      state: this.state,
      groups: this.groups.size,
      received: this.received,
      lastMessageAt: this.lastMessageAt,
    };
  }

  async stop() {
    this.stopped = true;
    try { this.sock?.end(undefined); } catch { /* ignore */ }
  }
}
