# WA Collector

A small always-on server that links to one or more WhatsApp numbers (as a "linked device") and saves every
group message into the WhatsApp Collector database (Supabase), where the web app shows them live.

- Connects directly to WhatsApp with [Baileys](https://github.com/WhiskeySockets/Baileys) — no browser needed.
- Reconnects automatically; messages missed while offline are delivered by WhatsApp on reconnect.
- Messages are queued and written in batches; if the database is unreachable they are kept on disk and retried.
- Several numbers can run side by side (`ACCOUNTS=phone1,phone2,...`), which is how it scales to hundreds of groups.

## Run on Railway

1. New project → Deploy from GitHub repo → this repo, branch `collector`.
2. Add a **Volume** mounted at `/data` (keeps the WhatsApp login and the pending queue across restarts).
3. Open the service's public URL → "סרוק קוד" → scan with WhatsApp: Settings → Linked devices → Link a device.

## Settings (all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACCOUNTS` | `phone1` | Comma-separated names, one per WhatsApp number |
| `ADMIN_TOKEN` | — | If set, the status/QR pages require `?token=...` |
| `SUPABASE_URL`, `SUPABASE_KEY` | WhatsApp Collector project | Database to write to |
| `DATA_DIR` | `/data` in Docker | Where logins and the pending queue are stored |
| `BATCH_SIZE`, `FLUSH_INTERVAL_MS` | `500`, `1000` | Write batching |

## Endpoints

- `/` — status of every number, messages received and written
- `/qr/<account>` — QR code for linking a number
- `/health` — JSON health check

## Tests

```
npm test
```
