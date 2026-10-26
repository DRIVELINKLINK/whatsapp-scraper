import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  // Defaults point at the WhatsApp Collector database. The publishable key is designed to be public
  // (it already ships inside the web app); row-level security decides what it may do.
  supabaseUrl: (process.env.SUPABASE_URL || "https://xxbstgdhtlalremiftwf.supabase.co").replace(/\/+$/, ""),
  supabaseKey: process.env.SUPABASE_KEY || "sb_publishable_5PJtkbKqZUwBNErDUb13wg_W-aT_g9Z",
  // Optional: when set, the status and QR pages require ?token=<ADMIN_TOKEN>.
  adminToken: process.env.ADMIN_TOKEN || "",
  // Comma-separated account names, one per WhatsApp number, e.g. "main" or "n1,n2,n3"
  accounts: (process.env.ACCOUNTS || "phone1").split(",").map((s) => s.trim()).filter(Boolean),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  flushIntervalMs: Number(process.env.FLUSH_INTERVAL_MS || 1000),
  batchSize: Number(process.env.BATCH_SIZE || 500),
  heartbeatMs: 30_000,
  groupsSyncMs: 30 * 60_000,
  logLevel: process.env.LOG_LEVEL || "info",
};
