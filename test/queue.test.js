import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fake database: answers 503 for the first `outage` requests, rejects rows whose body is "BAD", stores the rest.
const stored = new Map();
let outage = 2;
const fake = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (outage > 0) { outage--; res.writeHead(503); return res.end("down"); }
    const rows = JSON.parse(data);
    if (rows.some((r) => r.body === "BAD")) { res.writeHead(400); return res.end("bad row"); }
    for (const r of rows) stored.set(r.id, r);
    res.writeHead(201); res.end();
  });
});
await new Promise((r) => fake.listen(0, r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waq-"));
process.env.SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.SUPABASE_KEY = "x";
process.env.ADMIN_TOKEN = "t";
process.env.DATA_DIR = dir;
process.env.FLUSH_INTERVAL_MS = "50";
const { MessageQueue } = await import("../src/queue.js");
const quiet = { info() {}, warn() {}, error() {} };

const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("timeout");
};

test("survives an outage, drops only bad rows, dedupes, and keeps nothing pending", async () => {
  const q = new MessageQueue(quiet);
  for (let i = 0; i < 1200; i++) q.push({ id: `m${i}`, body: i === 7 ? "BAD" : "ok" });
  q.push({ id: "m1", body: "duplicate" }); // ignored
  await until(() => stored.size === 1199 && q.pending === 0);
  assert.equal(stored.get("m1").body, "ok");
  assert.equal(q.stats.dropped, 1);
  assert.ok(q.stats.failures >= 1, "outage was seen");
  assert.ok(!fs.existsSync(path.join(dir, "pending.jsonl")), "spill file cleaned up");
  await q.close();
});

test("pending rows survive a restart via the disk spill", async () => {
  fs.writeFileSync(path.join(dir, "pending.jsonl"), JSON.stringify({ id: "spilled", body: "ok" }) + "\n");
  const q = new MessageQueue(quiet);
  await until(() => stored.has("spilled"));
  await q.close();
  fake.close();
});
