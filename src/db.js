import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
  }
  get retryable() {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

/** Upsert rows into a Supabase table through the REST API. */
export async function upsert(table, rows, { ignoreDuplicates = false } = {}) {
  if (!rows.length) return;
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: config.supabaseKey,
      "Content-Type": "application/json",
      Prefer: `resolution=${ignoreDuplicates ? "ignore" : "merge"}-duplicates,return=minimal`,
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(res.status, (await res.text()).slice(0, 300));
}
