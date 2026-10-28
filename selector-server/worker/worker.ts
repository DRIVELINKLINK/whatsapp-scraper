// WhatsApp Selector — server-side DriveLink transfer.
// Same pipeline as the Transfer screen (useRideBoard + useDriveLink), so rides keep flowing
// to DriveLink while no browser is open. Uses the exact parsing files of the app (./lib).
import { cityKey, sheetToRows, type CityRow } from "./lib/city-match";
import { applyStreetResolution, parseRide, streetPhrases, type NoteFilter, type OfficialPlace, type PhoneKeyword, type PlaceAlias } from "./lib/ride-parse";
import { assessRide } from "./lib/ride-status";
import { autoEligible, MAX_ATTEMPTS, MAX_RIDES_PER_CALL, pushRides, toDriveLinkRide } from "./lib/drivelink";

const SB_URL = process.env.SUPABASE_URL || "https://xxbstgdhtlalremiftwf.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "";
const DL_URL = process.env.DRIVELINK_INTAKE_URL || "";
const DL_KEY = process.env.DRIVELINK_INTAKE_KEY || "";
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS || 20_000);
const DRY_RUN = process.env.DRY_RUN === "1";
const DAY = 24 * 60 * 60 * 1000;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------- Supabase REST ----------
async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`supabase ${res.status} ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
async function sbAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sb<T[]>(path, { headers: { Range: `${offset}-${offset + 999}`, "Range-Unit": "items" } });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
const inList = (ids: string[]) => `(${ids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",")})`;

// ---------- Official places (same sources as the app's places.functions.ts) ----------
const GOV_URL = "https://data.gov.il/api/3/action/datastore_search";
const CITIES_RESOURCE = "5c78e9fa-c2e2-4771-93ff-7f400a12f7ba";
const STREETS_RESOURCE = "9ad3862c-8391-4b2f-84a4-2d4c68625f4b";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1cc0ji7L5c06teG130uVxfO0HafaiwKH4AIubuE0Mimg/export?format=csv&gid=0";
type GovRecord = Record<string, unknown>;
const govJson = async (params: URLSearchParams) => {
  const res = await fetch(`${GOV_URL}?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`data.gov.il ${res.status}`);
  return (await res.json()) as { result?: { records?: GovRecord[] } };
};
let places: { at: number; official: OfficialPlace[]; sheet: CityRow[] } | null = null;
async function getPlaces() {
  if (places && Date.now() - places.at < DAY) return places;
  const official: OfficialPlace[] = [];
  let sheet: CityRow[] = places?.sheet ?? [];
  try {
    const json = await govJson(new URLSearchParams({ resource_id: CITIES_RESOURCE, limit: "2000" }));
    const seen = new Set<string>();
    for (const rec of json.result?.records ?? []) {
      const name = String(rec["שם_ישוב"] ?? "").replace(/\s+/g, " ").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      official.push({ name, code: String(rec["סמל_ישוב"] ?? "") });
    }
  } catch (e) { log("official cities failed:", String(e)); }
  try {
    const res = await fetch(SHEET_URL, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) sheet = sheetToRows(await res.text());
  } catch (e) { log("sheet failed:", String(e)); }
  if (official.length) places = { at: Date.now(), official, sheet };
  else if (!places) places = { at: 0, official: [], sheet }; // retry next cycle
  return places;
}
let streetIndex: { at: number; index: Map<string, string[]> } | null = null;
async function getStreetIndex() {
  if (streetIndex && Date.now() - streetIndex.at < DAY) return streetIndex.index;
  const sets = new Map<string, Set<string>>();
  try {
    for (let offset = 0; ; offset += 32000) {
      const json = await govJson(new URLSearchParams({ resource_id: STREETS_RESOURCE, limit: "32000", offset: String(offset) }));
      const records = json.result?.records ?? [];
      for (const rec of records) {
        const street = String(rec["שם_רחוב"] ?? "").replace(/\s+/g, " ").trim();
        const city = String(rec["שם_ישוב"] ?? "").replace(/\s+/g, " ").trim();
        const key = cityKey(street);
        if (!key || key.length < 3 || !city) continue;
        const set = sets.get(key) ?? new Set<string>();
        set.add(city);
        sets.set(key, set);
      }
      if (records.length < 32000) break;
    }
    const index = new Map([...sets].map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b, "he"))]));
    streetIndex = { at: Date.now(), index };
    log("street index loaded:", index.size, "names");
  } catch (e) {
    log("street index failed:", String(e));
    if (!streetIndex) return new Map<string, string[]>();
  }
  return streetIndex!.index;
}

// ---------- One cycle ----------
type Msg = { id: string; group_id: string | null; group_name: string | null; body: string | null; timestamp: string | null; sender_name: string | null; sender_phone: string | null; is_duplicate: boolean };
type Override = { message_id: string; origin: string | null; destination: string | null; phone_choice: string | null; dismissed_at: string | null; price: number | null; ride_time: string | null; notes: string | null; phone: string | null; wa_link: string | null; tg_link: string | null; approved_at: string | null };
type Transfer = { message_id: string; status: string; attempts: number };

export async function cycle() {
  const settings = (await sb<{ auto_transfer: boolean; auto_transfer_since: string | null }[]>("wa_display_settings?id=eq.main&select=auto_transfer,auto_transfer_since"))[0];
  if (!settings?.auto_transfer || !settings.auto_transfer_since) return { skipped: "auto transfer is off" };
  const since = settings.auto_transfer_since;
  const from = new Date(Math.max(Date.parse(since), Date.now() - DAY)).toISOString();

  const groups = await sbAll<{ id: string; name: string }>("wa_groups?select=id,name&enabled=eq.true&pending_review=eq.false&order=id");
  if (!groups.length) return { skipped: "no active groups" };
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const messages: Msg[] = [];
  for (let i = 0; i < groups.length; i += 100) {
    const ids = groups.slice(i, i + 100).map((g) => g.id);
    messages.push(...await sbAll<Msg>(`wa_messages?select=id,group_id,group_name,body,timestamp,sender_name,sender_phone,is_duplicate&is_duplicate=eq.false&timestamp=gte.${encodeURIComponent(from)}&group_id=in.${encodeURIComponent(inList(ids))}&order=timestamp.desc`));
  }
  if (!messages.length) return { messages: 0 };

  const [aliasRows, keywordRows, filterRows, overrides, transfers, place] = await Promise.all([
    sbAll<PlaceAlias & { id: string }>("wa_place_aliases?select=alias,official_name,is_display,keep_in_notes,use_for_parse,is_hero&order=alias"),
    sbAll<PhoneKeyword>("wa_phone_keywords?select=phrase,kind&order=phrase"),
    sbAll<NoteFilter>("wa_note_filters?select=phrase,kind&order=phrase"),
    sbAll<Override>("wa_ride_overrides?select=*"),
    sbAll<Transfer>(`wa_transfers?select=message_id,status,attempts&sent_at=gte.${encodeURIComponent(new Date(Date.now() - 2 * DAY).toISOString())}`),
    getPlaces(),
  ]);
  const keywords = keywordRows.filter((k) => k.kind === "dispatcher" || k.kind === "ignore");
  const noteFilters = filterRows.filter((f) => f.kind === "line" || f.kind === "link");
  const overrideMap = new Map(overrides.map((o) => [o.message_id, o]));
  const transferMap = new Map(transfers.map((t) => [t.message_id, t]));

  // buildBase (same as useRideBoard)
  const base = messages.map((message) => {
    const parsed = parseRide(message.body ?? "", {
      aliases: aliasRows,
      official: place.official.length ? place.official : undefined,
      sheet: place.sheet.length ? place.sheet : undefined,
      keywords,
      noteFilters,
    });
    const o = overrideMap.get(message.id);
    const ride = o ? {
      ...parsed,
      price: o.price ?? parsed.price,
      time: o.ride_time ?? parsed.time,
      notes: o.notes ?? parsed.notes,
      notesLines: o.notes != null ? o.notes.split(/\r?\n/).filter(Boolean) : parsed.notesLines,
      waLink: o.wa_link ?? parsed.waLink,
      tgLink: o.tg_link ?? parsed.tgLink,
    } : parsed;
    return {
      message, ride, override: o,
      groupName: groupName.get(message.group_id ?? "") ?? message.group_name ?? "—",
      origin: o?.origin ?? ride.origin,
      destination: o?.destination ?? ride.destination,
    };
  }).filter((row) => row.ride.isRide && !row.override?.dismissed_at);

  const needsStreets = base.some((row) => !row.origin || !row.destination);
  const streets = needsStreets ? await getStreetIndex() : new Map<string, string[]>();

  // finish (same as useRideBoard) + status
  const ready = [];
  for (const row of base) {
    let { origin, destination } = row;
    let pickupAddress = "";
    if (!origin || !destination) {
      const phrases = streetPhrases(row.ride);
      const street = applyStreetResolution({ origin, destination, phrases, resolve: (p) => streets.get(cityKey(p)) });
      origin = street.origin;
      destination = street.destination;
      pickupAddress = phrases.find((p) => { const c = streets.get(cityKey(p)); return c?.length === 1 && c[0] === origin; }) ?? "";
    }
    if (!pickupAddress && row.ride.originToken) {
      const k = cityKey(row.ride.originToken);
      if (aliasRows.some((a) => a.keep_in_notes && cityKey(a.alias) === k)) pickupAddress = row.ride.originToken;
    }
    const a = assessRide({
      text: row.message.body ?? "", origin, destination, senderPhone: row.message.sender_phone, keywords,
      phoneChoice: row.override?.phone_choice ?? null, hasLink: Boolean(row.ride.waLink || row.ride.tgLink),
      internalConflict: row.ride.internalConflict, overridePhone: row.override?.phone ?? null, adminApproved: Boolean(row.override?.approved_at),
    });
    if (a.status !== "ready") continue;
    const full = { message: row.message, ride: row.ride, groupName: row.groupName, origin, destination, pickupAddress, phone: a.phone };
    const t = transferMap.get(row.message.id);
    if (t && (t.status !== "error" || t.attempts >= MAX_ATTEMPTS)) continue;
    if (!autoEligible(full, since)) continue;
    ready.push(full);
  }
  if (!ready.length) return { messages: messages.length, ready: 0 };

  const batch = ready.slice(0, MAX_RIDES_PER_CALL).map((r) => toDriveLinkRide(r));
  if (DRY_RUN) { log("DRY RUN would send:", JSON.stringify(batch.map((b) => [b.source_ref, b.pickup_city, b.dest_city, b.price]))); return { ready: ready.length, dry: true }; }
  if (!DL_URL || !DL_KEY) return { ready: ready.length, error: "DRIVELINK_INTAKE_URL / KEY missing in .env" };
  const results = await pushRides(batch, DL_URL, DL_KEY);
  const rows = results.map((res) => ({
    message_id: res.source_ref,
    status: res.ok ? (res.duplicate ? "duplicate" : "sent") : "error",
    ride_number: res.ride_number ?? null,
    error: res.ok ? null : res.error ?? "שגיאה",
    attempts: (transferMap.get(res.source_ref)?.attempts ?? 0) + 1,
    sent_at: new Date().toISOString(),
  }));
  await sb("wa_transfers?on_conflict=message_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  return { ready: ready.length, sent: rows.filter((r) => r.status === "sent").length, duplicate: rows.filter((r) => r.status === "duplicate").length, errors: rows.filter((r) => r.status === "error").map((r) => r.error) };
}

if (process.env.WORKER_NO_LOOP !== "1") (async function loop() {
  if (!SB_KEY) { log("SUPABASE_KEY missing in .env"); process.exit(1); }
  log("worker started", { interval: INTERVAL, dryRun: DRY_RUN, drivelink: Boolean(DL_URL && DL_KEY) });
  let last = "";
  for (;;) {
    try {
      const result = JSON.stringify(await cycle());
      if (result !== last || !result.includes('"ready":0')) log(result);
      last = result;
    } catch (e) {
      log("cycle error:", String(e instanceof Error ? e.message : e));
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
})();
