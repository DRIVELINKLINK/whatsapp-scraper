import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { upsert, HttpError } from "./db.js";

/**
 * Durable write queue for messages.
 * - Rows are batched and written every FLUSH_INTERVAL_MS (or sooner when a batch fills up).
 * - If the database is unreachable, rows are spilled to disk and retried, so nothing is lost on a restart.
 * - A row the database rejects is isolated and dropped so it can't block everything behind it.
 */
export class MessageQueue {
  constructor(logger) {
    this.log = logger;
    this.mem = [];
    this.seen = new Map(); // id -> time, short-term dedupe
    this.spillFile = path.join(config.dataDir, "pending.jsonl");
    this.flushing = false;
    this.stats = { written: 0, dropped: 0, failures: 0, lastError: null, lastWriteAt: null };
    this.backoffMs = 0;
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.loadSpill();
    this.timer = setInterval(() => this.flush(), config.flushIntervalMs);
  }

  get pending() {
    return this.mem.length;
  }

  push(row) {
    if (!row || !row.id) return;
    const now = Date.now();
    if (this.seen.has(row.id)) return;
    this.seen.set(row.id, now);
    if (this.seen.size > 200_000) {
      for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    }
    this.mem.push(row);
    if (this.mem.length >= config.batchSize) this.flush();
  }

  loadSpill() {
    if (!fs.existsSync(this.spillFile)) return;
    const lines = fs.readFileSync(this.spillFile, "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try { this.mem.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
    }
    fs.rmSync(this.spillFile);
    if (lines.length) this.log.info({ count: lines.length }, "restored pending messages from disk");
  }

  spill() {
    if (!this.mem.length) return;
    fs.writeFileSync(this.spillFile, this.mem.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  async flush() {
    if (this.flushing || !this.mem.length) return;
    if (this.backoffMs && Date.now() < this.retryAt) return;
    this.flushing = true;
    try {
      while (this.mem.length) {
        const batch = this.mem.slice(0, config.batchSize);
        await this.writeBatch(batch);
        this.mem.splice(0, batch.length);
        this.stats.written += batch.length;
        this.stats.lastWriteAt = new Date().toISOString();
      }
      this.backoffMs = 0;
      if (fs.existsSync(this.spillFile)) fs.rmSync(this.spillFile);
    } catch (e) {
      this.stats.failures++;
      this.stats.lastError = String(e.message).slice(0, 300);
      this.backoffMs = Math.min(60_000, Math.max(2_000, this.backoffMs * 2));
      this.retryAt = Date.now() + this.backoffMs;
      this.spill();
      this.log.warn({ err: e.message, pending: this.mem.length, retryInMs: this.backoffMs }, "write failed, will retry");
    } finally {
      this.flushing = false;
    }
  }

  async writeBatch(batch) {
    try {
      await upsert("wa_messages", batch, { ignoreDuplicates: true });
    } catch (e) {
      if (!(e instanceof HttpError) || e.retryable) throw e;
      // The database rejected something in this batch: write one by one and drop only the bad rows.
      this.log.warn({ err: e.message }, "batch rejected, isolating bad rows");
      for (const row of batch) {
        try {
          await upsert("wa_messages", [row], { ignoreDuplicates: true });
        } catch (e2) {
          if (!(e2 instanceof HttpError) || e2.retryable) throw e2;
          this.stats.dropped++;
          this.stats.lastError = String(e2.message).slice(0, 300);
          this.log.error({ err: e2.message, id: row.id }, "dropping row the database rejects");
        }
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
    this.spill();
  }
}
