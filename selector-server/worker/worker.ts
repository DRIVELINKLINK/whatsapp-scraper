// WhatsApp Selector — server-side DriveLink transfer.
// Same pipeline as the Transfer screen (useRideBoard + useDriveLink), so rides keep flowing
// to DriveLink while no browser is open. Uses the exact parsing files of the app (./lib).
import { cityKey } from "./lib/city-match";
import { applyStreetResolution, parseRide, resolveSinglePlace, rideTextPhones, splitRideBlocks, streetPhrases, type NoteFilter, type OfficialPlace, type PhoneKeyword, type PlaceAlias, type PlaceOptions } from "./lib/ride-parse";
import { assessRide } from "./lib/ride-status";
import { autoEligible, MAX_ATTEMPTS, MAX_RIDES_PER_CALL, pushRides, toDriveLinkRide } from "./lib/drivelink";
import { autoDismissRows, markDuplicatesExceptSplitParents } from "./lib/ride-rules";
import { autoSplitRows } from "./lib/ride-split";
import { lookupCandidates, photonPick, type PhotonFeature } from "./lib/place-lookup";
import { splitPart } from "./lib/ride-parse";

const SB_URL = process.env.SUPABASE_URL || "https://xxbstgdhtlalremiftwf.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "";
const DL_URL = process.env.DRIVELINK_INTAKE_URL || "";
const DL_KEY = process.env.DRIVELINK_INTAKE_KEY || "";
// One ride every 5 seconds: steady flow, drivers never get a burst of rides at once.
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS || 5_000);
const PER_CYCLE = Math.max(1, Number(process.env.WORKER_RIDES_PER_CYCLE || 1));
const DRY_RUN = process.env.DRY_RUN === "1";
// Private key for the worker-only database functions (settings, keywords, filters and overrides are
// locked to signed-in users in the app, so the worker reads them through worker_config / worker_overrides).
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
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
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return sb<T>(`rpc/${fn}`, { method: "POST", body: JSON.stringify({ p_token: WORKER_TOKEN, ...args }) });
}
type WorkerConfig = {
  settings: { auto_transfer: boolean; auto_transfer_since: string | null; notes_template?: string | null } | null;
  keywords: PhoneKeyword[];
  note_filters: NoteFilter[];
};
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
type GovRecord = Record<string, unknown>;
const govJson = async (params: URLSearchParams) => {
  const res = await fetch(`${GOV_URL}?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`data.gov.il ${res.status}`);
  return (await res.json()) as { result?: { records?: GovRecord[] } };
};
let places: { at: number; official: OfficialPlace[] } | null = null;
async function getPlaces() {
  if (places && Date.now() - places.at < DAY) return places;
  const official: OfficialPlace[] = [];
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
  if (official.length) places = { at: Date.now(), official };
  else if (!places) places = { at: 0, official: [] }; // retry next cycle
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

// ---------- Automatic place aliases (Photon) ----------
// Unknown phrases in rides are looked up at most once each (cached in wa_place_lookups), one request
// per cycle so the free Photon service is never flooded. Manual aliases always win (DB trigger).
const PHOTON_URL = "https://photon.komoot.io/api/";
let lookupKeys: Set<string> | null = null;
const lookupQueue: string[] = [];
async function photonStep(officialNames: string[]) {
  const phrase = lookupQueue.shift();
  if (!phrase) return null;
  const key = cityKey(phrase);
  if (!key || lookupKeys?.has(key)) return null;
  lookupKeys?.add(key);
  const params = new URLSearchParams({ q: phrase, bbox: "34.2,29.4,35.9,33.3", limit: "10" });
  const res = await fetch(`${PHOTON_URL}?${params}`, { headers: { "User-Agent": "wa-selector-worker/1.0" }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) { lookupKeys?.delete(key); throw new Error(`photon ${res.status}`); }
  const json = (await res.json()) as { features?: PhotonFeature[] };
  const pick = photonPick(phrase, json.features ?? [], officialNames);
  const status = await rpc<string>("worker_lookup_result", { p_key: key, p_phrase: phrase, p_official: pick?.official_name ?? null, p_detail: pick?.detail ?? null });
  if (pick && status === "matched") { log("auto alias:", phrase, "→", pick.official_name); if (configCache) configCache.at = 0; }
  return pick;
}

// ---------- One cycle ----------
type Msg = { id: string; split_of: string | null; group_id: string | null; group_name: string | null; body: string | null; timestamp: string | null; sender: string | null; sender_id: string | null; sender_name: string | null; sender_phone: string | null; account: string | null; type: string | null; from_me: boolean | null; is_duplicate: boolean };
type Override = { message_id: string; origin: string | null; destination: string | null; phone_choice: string | null; dismissed_at: string | null; dismiss_kind?: string | null; auto_dismiss_skip?: boolean | null; price: number | null; ride_time: string | null; notes: string | null; phone: string | null; wa_link: string | null; tg_link: string | null; approved_at: string | null };
type Transfer = { message_id: string; status: string; attempts: number };

// Parse results per message (re-parsed only when the message, its override or the settings change).
type BaseRow = { message: Msg; ride: ReturnType<typeof parseRide>; override: Override | undefined; multiRideCount: number; inheritedPhoneAmbiguous: boolean; groupName: string; origin: string | null; destination: string | null };
const baseCache = new Map<string, { key: string; value: BaseRow }>();

// ---------- Incremental loading (keeps Supabase traffic small) ----------
const FULL_MESSAGES_MS = 30 * 60_000;
const FULL_SMALL_MS = 10 * 60_000;
const CONFIG_MS = 60_000;
const MSG_COLS = "id,split_of,group_id,group_name,body,timestamp,sender,sender_id,sender_name,sender_phone,account,type,from_me,is_duplicate,created_at";
type CachedMsg = Msg & { created_at: string };
const msgCache = new Map<string, CachedMsg>();
let msgState = { at: 0, groups: "", from: "", lastCreated: "" };
async function fetchMessages(ids: string[], filter: string): Promise<CachedMsg[]> {
  const out: CachedMsg[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    out.push(...await sbAll<CachedMsg>(`wa_messages?select=${MSG_COLS}&${filter}&group_id=in.${encodeURIComponent(inList(chunk))}&order=created_at.asc`));
  }
  return out;
}
async function loadMessages(ids: string[], from: string): Promise<Msg[]> {
  const groupsKey = ids.join(",");
  const full = !msgState.lastCreated || Date.now() - msgState.at > FULL_MESSAGES_MS || groupsKey !== msgState.groups || from < msgState.from;
  if (full) {
    msgCache.clear();
    for (const m of await fetchMessages(ids, `timestamp=gte.${encodeURIComponent(from)}`)) msgCache.set(m.id, m);
    msgState = { at: Date.now(), groups: groupsKey, from, lastCreated: "" };
  } else {
    // New rows only; a 2-minute overlap catches inserts that committed out of order.
    const after = new Date(Date.parse(msgState.lastCreated) - 120_000).toISOString();
    for (const m of await fetchMessages(ids, `created_at=gt.${encodeURIComponent(after)}&timestamp=gte.${encodeURIComponent(from)}`)) msgCache.set(m.id, m);
    msgState.from = from;
  }
  let last = msgState.lastCreated;
  for (const [id, m] of msgCache) {
    if (!m.timestamp || m.timestamp < from) { msgCache.delete(id); continue; }
    if (m.created_at > last) last = m.created_at;
  }
  msgState.lastCreated = last || new Date().toISOString();
  return [...msgCache.values()].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
}

let configCache: { at: number; aliasRows: PlaceAlias[]; customPlaces: { name: string }[]; keywords: PhoneKeyword[]; noteFilters: NoteFilter[] } | null = null;
async function loadConfig() {
  if (configCache && Date.now() - configCache.at < CONFIG_MS) return configCache;
  const [aliasRows, customPlaces, worker] = await Promise.all([
    sbAll<PlaceAlias>("wa_place_aliases?select=alias,official_name,is_display,keep_in_notes,use_for_parse,is_hero&order=alias"),
    sbAll<{ name: string }>("wa_custom_places?select=name&order=name"),
    rpc<WorkerConfig>("worker_config", {}),
  ]);
  const keywordRows = worker.keywords ?? [];
  const filterRows = worker.note_filters ?? [];
  configCache = {
    at: Date.now(), aliasRows, customPlaces,
    keywords: keywordRows.filter((k) => k.kind === "dispatcher" || k.kind === "ignore"),
    noteFilters: filterRows.filter((f) => f.kind === "line" || f.kind === "link"),
  };
  return configCache;
}

const overrideCache = new Map<string, Override & { updated_at?: string }>();
let overrideState = { at: 0, last: "" };
async function loadOverrides() {
  if (!overrideState.last || Date.now() - overrideState.at > FULL_SMALL_MS) {
    overrideCache.clear();
    for (const o of await rpc<(Override & { updated_at: string })[]>("worker_overrides", { p_since: null })) overrideCache.set(o.message_id, o);
    overrideState.at = Date.now();
  } else {
    const after = new Date(Date.parse(overrideState.last) - 120_000).toISOString();
    for (const o of await rpc<(Override & { updated_at: string })[]>("worker_overrides", { p_since: after })) overrideCache.set(o.message_id, o);
  }
  let last = overrideState.last;
  for (const o of overrideCache.values()) if (o.updated_at && o.updated_at > last) last = o.updated_at;
  overrideState.last = last || new Date(0).toISOString();
  return overrideCache;
}

const emptyOverride = (message_id: string): Override => ({ message_id, origin: null, destination: null, phone_choice: null, dismissed_at: null, price: null, ride_time: null, notes: null, phone: null, wa_link: null, tg_link: null, approved_at: null });

const transferCache = new Map<string, Transfer>();
let transferAt = 0;
async function loadTransfers() {
  if (!transferAt || Date.now() - transferAt > FULL_SMALL_MS) {
    transferCache.clear();
    for (const t of await sbAll<Transfer>(`wa_transfers?select=message_id,status,attempts&sent_at=gte.${encodeURIComponent(new Date(Date.now() - 2 * DAY).toISOString())}`)) transferCache.set(t.message_id, t);
    transferAt = Date.now();
  }
  return transferCache;
}

// ---------- Two loops: "process" (read, parse, split, remove, queue) and "send" (one ride every INTERVAL) ----------
// Sending never waits for the heavy processing, so the gap between rides stays exactly INTERVAL.
type Payload = ReturnType<typeof toDriveLinkRide>;
let readyQueue: Payload[] = [];
export const stats = { cycleMs: 0, readMs: 0, queue: 0, lastSendAt: 0 };
let photonNames: string[] = [];
export async function photonTick() { if (photonNames.length) await photonStep(photonNames); }

export async function cycle() {
  const processed = await processCycle();
  const sent = await sendNext();
  await photonTick();
  return { ...processed, ...sent };
}

export async function processCycle() {
  const started = Date.now();
  try { return await processInner(); } finally { stats.cycleMs = Date.now() - started; }
}

async function processInner() {
  const t0 = Date.now();
  // All reads in parallel: one network round trip instead of six in a row.
  const [workerCfg, groups, config, overrideMap, transferMap, place] = await Promise.all([
    rpc<WorkerConfig>("worker_config", {}),
    sbAll<{ id: string; name: string }>("wa_groups?select=id,name&enabled=eq.true&pending_review=eq.false&order=id"),
    loadConfig(), loadOverrides(), loadTransfers(), getPlaces(),
  ]);
  const settings = workerCfg.settings;
  // Splitting and auto-removal always run; only the sending to DriveLink depends on the switch.
  const sending = Boolean(settings?.auto_transfer && settings.auto_transfer_since);
  const since = settings?.auto_transfer_since ?? null;
  // Duplicates are decided like the app: over every ride of the last 24 hours (dismissed ones too),
  // so the window here is always 24h; autoEligible(since) still limits what is sent.
  const from = new Date(Date.now() - DAY).toISOString();

  if (!groups.length) return { skipped: "no active groups" };
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const messages = await loadMessages(groups.map((g) => g.id), from);
  if (!messages.length) return { messages: 0 };
  stats.readMs = Date.now() - t0;
  const { aliasRows, customPlaces, keywords, noteFilters } = config;
  const parseOptions: PlaceOptions = { aliases: aliasRows, official: place.official.length ? place.official : undefined, custom: customPlaces, keywords, noteFilters };
  const byId = new Map(messages.map((m) => [m.id, m]));

  // buildBase (same as useRideBoard)
  // Re-parse only when the content of the settings changes (not on every minute's reload).
  const configKey = JSON.stringify([aliasRows, customPlaces, keywords, noteFilters, place.official.length]);
  const base = messages.map((message) => {
    const o = overrideMap.get(message.id);
    const parent = message.split_of ? byId.get(message.split_of) : null;
    const key = JSON.stringify([configKey, message.body, message.group_id, o ?? null, parent?.body ?? null, groupName.get(message.group_id ?? "") ?? null]);
    const hit = baseCache.get(message.id);
    if (hit && hit.key === key) return { ...hit.value, message };
    const value = buildBase(message, o, parent ?? null);
    baseCache.set(message.id, { key, value });
    return value;
  }).filter((row) => row.ride.isRide);
  for (const id of baseCache.keys()) if (!byId.has(id)) baseCache.delete(id);

  function buildBase(message: Msg, o: Override | undefined, parent: Msg | null) {
    const parsed = parseRide(message.body ?? "", parseOptions);
    const multi = message.split_of ? { blocks: [], shared: [] } : splitRideBlocks(message.body ?? "", parseOptions);
    // Children carry their attached contact in their own body (see blockContacts).
    const childHasPhone = rideTextPhones(message.body ?? "", keywords).length > 0;
    const inheritedPhoneAmbiguous = Boolean(parent && !childHasPhone && rideTextPhones(parent.body ?? "", keywords).length > 1);
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
      message, ride, override: o, multiRideCount: multi.blocks.length >= 2 ? multi.blocks.length : 0, inheritedPhoneAmbiguous,
      groupName: groupName.get(message.group_id ?? "") ?? message.group_name ?? "—",
      origin: o?.origin ?? ride.origin,
      destination: o?.destination ?? ride.destination,
    };
  }

  // ---- Auto split (server only): a message with 2+ rides becomes separate rides, like the split button.
  let splitCount = 0;
  for (const row of base) {
    if (splitCount >= 20) break;
    if (row.multiRideCount < 2 || row.message.split_of || row.override?.dismissed_at) continue;
    const children = autoSplitRows(row.message, parseOptions);
    if (children.length < 2) continue;
    await sb("wa_messages?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(children) });
    await rpc("worker_dismiss", { p_rows: [{ message_id: row.message.id, dismiss_kind: "split" }] });
    overrideCache.set(row.message.id, { ...(row.override ?? emptyOverride(row.message.id)), dismissed_at: new Date().toISOString(), dismiss_kind: "split" });
    splitCount++;
  }
  if (splitCount) log("auto split:", splitCount, "messages");

  // ---- Photon: queue unknown phrases of recent open rides that miss a place or were guessed internal.
  if (!lookupKeys) lookupKeys = new Set(await rpc<string[]>("worker_lookup_keys", {}));
  const knownNames = [...place.official.map((p) => p.name), ...customPlaces.map((c) => c.name)];
  if (!lookupQueue.length) {
    for (const row of base) {
      if (lookupQueue.length >= 20) break;
      if (row.override?.dismissed_at || !row.message.timestamp || Date.parse(row.message.timestamp) < Date.now() - 3 * 60 * 60_000) continue;
      if (row.origin && row.destination && !row.ride.singlePlaceInferred) continue;
      for (const phrase of lookupCandidates(row.ride, { knownNames, aliases: aliasRows, keywords, noteFilters, skipKeys: lookupKeys })) {
        if (!lookupQueue.includes(phrase)) lookupQueue.push(phrase);
      }
    }
  }
  // Photon runs in its own loop (see main) so a slow lookup never delays rides.
  photonNames = knownNames;

  const needsStreets = base.some((row) => !row.override?.dismissed_at && (!row.origin || !row.destination || (row.ride.singlePlaceInferred && row.override?.destination == null)));
  const streets = needsStreets ? await getStreetIndex() : new Map<string, string[]>();

  // finish (same as useRideBoard) + status
  const finished = [];
  for (const row of base) {
    const origin = row.origin;
    let destination = row.destination;
    let singlePlaceUnsure = row.ride.singlePlaceUnsure && !row.destination;
    if (row.ride.singlePlaceInferred && row.override?.destination == null) {
      const single = resolveSinglePlace(row.ride, origin, (p) => streets.get(cityKey(p)));
      destination = single.destination; singlePlaceUnsure = single.unsure;
    }
    let pickupAddress = "";
    if (!origin || !destination) {
      // Streets are suggestions only (same as the app); they never fill origin/destination.
      const phrases = streetPhrases(row.ride);
      applyStreetResolution({ origin, destination, phrases, resolve: (p) => streets.get(cityKey(p)) });
      pickupAddress = phrases.find((p) => { const c = streets.get(cityKey(p)); return c?.length === 1 && c[0] === origin; }) ?? "";
    }
    if (!pickupAddress && row.ride.originToken) {
      const k = cityKey(row.ride.originToken);
      if (aliasRows.some((a) => a.keep_in_notes && cityKey(a.alias) === k)) pickupAddress = row.ride.originToken;
    }
    // Same arguments as useRideBoard.finish in the app.
    const a = assessRide({
      multiRideCount: row.multiRideCount, inheritedPhoneAmbiguous: row.inheritedPhoneAmbiguous,
      text: row.message.body ?? "", origin, destination, senderPhone: row.message.sender_phone, keywords,
      phoneChoice: row.override?.phone_choice ?? null, hasLink: Boolean(row.ride.waLink || row.ride.tgLink),
      verifiedLink: row.ride.verifiedLink, waLink: row.ride.waLink,
      singlePlaceUnsure,
      priceUnsure: row.ride.priceUnsure && row.ride.price === null,
      notesLineCount: row.ride.notesLines.length,
      internalConflict: row.ride.internalConflict, overridePhone: row.override?.phone ?? null, adminApproved: Boolean(row.override?.approved_at),
    });
    const streetsHere = streetPhrases(row.ride).filter((p) => { const c = streets.get(cityKey(p)); return Boolean(c?.length && ((origin && c.includes(origin)) || (destination && c.includes(destination)))); });
    const siblings = row.message.split_of ? messages.filter((m) => m.split_of === row.message.split_of).length : 0;
    finished.push({ message: row.message, ride: row.ride, groupName: row.groupName, origin, destination, pickupAddress, phone: a.phone, linkContact: a.linkContact, status: a.status,
      streets: streetsHere, splitPart: splitPart(row.message.id, row.message.split_of, siblings),
      approved: Boolean(row.override?.approved_at), multiRides: new Array(row.multiRideCount).fill(0),
      dismissed: Boolean(row.override?.dismissed_at), splitParent: row.multiRideCount >= 2 || row.override?.dismiss_kind === "split" });
  }
  // Duplicate = same dispatcher name + phone (or link) + origin + destination + price (app's markDuplicates);
  // a value missing in both counts as equal. Split parents never take part.
  const splitIds = new Set([...overrideCache.values()].filter((o) => o.dismiss_kind === "split").map((o) => o.message_id));
  const marked = markDuplicatesExceptSplitParents(finished, splitIds);

  // ---- Auto remove (server only): review rides not handled within 10 minutes.
  const toDismiss = autoDismissRows(marked.filter((r) => !r.dismissed && !r.splitParent), overrideCache, Date.now());
  if (toDismiss.length) {
    await rpc("worker_dismiss", { p_rows: toDismiss.map(({ message_id, dismiss_panel }) => ({ message_id, dismiss_kind: "auto", dismiss_panel })) });
    for (const d of toDismiss) overrideCache.set(d.message_id, { ...(overrideCache.get(d.message_id) ?? emptyOverride(d.message_id)), dismissed_at: d.dismissed_at, dismiss_kind: "auto" });
    log("auto removed:", toDismiss.length, "rides");
  }
  if (!sending) { readyQueue = []; stats.queue = 0; return { messages: messages.length, split: splitCount, removed: toDismiss.length, skipped: "auto transfer is off" }; }

  const ready = [];
  for (const full of marked) {
    if (full.message.is_duplicate || full.dismissed || full.splitParent || full.status !== "ready" || !full.phone) continue;
    // A guessed internal ride waits until its unknown words were looked up (they may be another city).
    if (full.ride.singlePlaceInferred && lookupCandidates(full.ride, { knownNames, aliases: aliasRows, keywords, noteFilters, skipKeys: lookupKeys ?? new Set() }).length) continue;
    const t = transferMap.get(full.message.id);
    if (t && (t.status !== "error" || t.attempts >= MAX_ATTEMPTS)) continue;
    if (!autoEligible(full, since)) continue;
    ready.push(full);
  }
  // Oldest waiting ride first, so nothing is starved behind newer messages.
  ready.sort((a, b) => (a.message.timestamp ?? "").localeCompare(b.message.timestamp ?? ""));
  readyQueue = ready.map((r) => toDriveLinkRide(r, { notesTemplate: settings?.notes_template ?? null, aliases: aliasRows }))
    // DriveLink limits (notes 2000, original text 10000, names 80): never let a long template reject a ride.
    .map((b) => ({ ...b, notes: b.notes.slice(0, 2000), original_text: b.original_text.slice(0, 10000), pickup_city_display: b.pickup_city_display.slice(0, 80), dest_city_display: b.dest_city_display.slice(0, 80) }));
  stats.queue = readyQueue.length;
  return { messages: messages.length, split: splitCount, removed: toDismiss.length, ready: ready.length };
}

export async function sendNext() {
  const count = Math.min(PER_CYCLE, MAX_RIDES_PER_CALL);
  const batch: Payload[] = [];
  while (batch.length < count && readyQueue.length) {
    const next = readyQueue.shift()!;
    const t = transferCache.get(next.source_ref);
    if (t && (t.status !== "error" || t.attempts >= MAX_ATTEMPTS)) continue; // sent meanwhile
    batch.push(next);
  }
  stats.queue = readyQueue.length;
  if (!batch.length) return {};
  if (DRY_RUN) { log("DRY RUN would send:", JSON.stringify(batch.map((b) => [b.source_ref, b.pickup_city, b.dest_city, b.price]))); return { dry: true }; }
  if (!DL_URL || !DL_KEY) return { error: "DRIVELINK_INTAKE_URL / KEY missing in .env" };
  const transferMap = transferCache;
  stats.lastSendAt = Date.now();
  const results = await pushRides(batch, DL_URL, DL_KEY);
  const rows = results.map((res) => ({
    message_id: res.source_ref,
    status: res.ok ? (res.duplicate ? "duplicate" : "sent") : "error",
    ride_number: res.ride_number ?? null,
    error: res.ok ? null : res.error ?? "שגיאה",
    attempts: (transferMap.get(res.source_ref)?.attempts ?? 0) + 1,
    sent_at: new Date().toISOString(),
  }));
  // "duplicate" means DriveLink already has the ride (e.g. the browser sent it first): never overwrite that record.
  const fresh = rows.filter((r) => r.status !== "duplicate");
  const dupes = rows.filter((r) => r.status === "duplicate");
  if (fresh.length) await sb("wa_transfers?on_conflict=message_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(fresh) });
  if (dupes.length) await sb("wa_transfers?on_conflict=message_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(dupes) });
  for (const r of rows) transferCache.set(r.message_id, { message_id: r.message_id, status: r.status, attempts: r.attempts });
  return { sent: rows.filter((r) => r.status === "sent").length, duplicate: rows.filter((r) => r.status === "duplicate").length, errors: rows.filter((r) => r.status === "error").map((r) => r.error) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (process.env.WORKER_NO_LOOP !== "1") (async function main() {
  if (!SB_KEY) { log("SUPABASE_KEY missing in .env"); process.exit(1); }
  if (!WORKER_TOKEN) log("WORKER_TOKEN missing in .env — settings/keywords/overrides cannot be read");
  log("worker started", { interval: INTERVAL, perCycle: PER_CYCLE, dryRun: DRY_RUN, drivelink: Boolean(DL_URL && DL_KEY) });
  let lastError: string | null = null;
  let last = "";
  // Process loop: runs back to back with a 2-second pause.
  const processLoop = async () => {
    for (;;) {
      try {
        const result = JSON.stringify(await processCycle());
        if (result !== last) log(result, `cycle ${stats.cycleMs}ms`);
        last = result;
        lastError = null;
      } catch (e) {
        lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
        log("cycle error:", lastError);
      }
      await sleep(1_000);
    }
  };
  // Send loop: a ready ride goes out at once, but never sooner than INTERVAL after the previous one.
  const sendLoop = async () => {
    for (;;) {
      if (readyQueue.length && Date.now() - stats.lastSendAt >= INTERVAL) {
        try {
          const result = await sendNext();
          if (Object.keys(result).length) log(JSON.stringify(result), `queue ${stats.queue}`);
        } catch (e) {
          lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
          log("send error:", lastError);
          stats.lastSendAt = Date.now();
        }
      }
      await sleep(200);
    }
  };
  // Sign of life once a minute (row id "worker" in wa_status) with speed numbers.
  const beatLoop = async () => {
    for (;;) {
      await sb("wa_status?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ id: "worker", last_heartbeat: new Date().toISOString(), version: `worker · cycle ${(stats.cycleMs / 1000).toFixed(1)}s · read ${(stats.readMs / 1000).toFixed(1)}s · queue ${stats.queue}`, pending: stats.queue, last_error: lastError }]) })
        .catch((e) => log("heartbeat failed:", String(e)));
      await sleep(60_000);
    }
  };
  // Photon loop: at most one lookup every 3 seconds, independent of processing and sending.
  const photonLoop = async () => {
    for (;;) {
      try { await photonTick(); } catch (e) { log("photon failed:", String(e instanceof Error ? e.message : e)); }
      await sleep(3_000);
    }
  };
  await Promise.all([processLoop(), sendLoop(), beatLoop(), photonLoop()]);
})();
