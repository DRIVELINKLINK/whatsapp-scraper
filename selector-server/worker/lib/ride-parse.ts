// Copied from the WhatsApp Selector app (src/lib/ride-parse.ts). Keep in sync.
import { cityKey } from "./city-match";

export type PhoneKeyword = { phrase: string; kind: "dispatcher" | "ignore" };
export type PlaceAlias = { alias: string; official_name: string; is_display: boolean; keep_in_notes: boolean; use_for_parse?: boolean; is_hero?: boolean };
export type NoteFilter = { phrase: string; kind: "line" | "link" };
export type OfficialPlace = { code: string; name: string };
export type Ride = {
  isRide: boolean;
  origin: string | null;
  destination: string | null;
  price: number | null;
  time: string | null;
  notes: string;
  notesLines: string[];
  dispatcherPhone: string | null;
  originToken: string | null;
  destinationToken: string | null;
  waLink: string | null;
  tgLink: string | null;
  /** A פ/פנימי-marked internal ride that also mentions two or more other known places. */
  internalConflict: boolean;
  singlePlaceUnsure: boolean;
  priceUnsure: boolean;
  verifiedLink: boolean;
};

export const DEFAULT_PHONE_KEYWORDS: PhoneKeyword[] = [
  ...["לבקש פה", "לבקש במס", "לבקש ב", "לפנות למס", "לפנות ל", "להתקשר", "לתיאום"].map((phrase) => ({ phrase, kind: "dispatcher" as const })),
  ...["מספרי הפצה", "לצרף", "צרפו"].map((phrase) => ({ phrase, kind: "ignore" as const })),
];

export type PlaceOptions = {
  aliases?: PlaceAlias[] | undefined;
  official?: OfficialPlace[] | undefined;
  custom?: { name: string }[] | undefined;
  keywords?: PhoneKeyword[] | undefined;
  noteFilters?: NoteFilter[] | undefined;
};

const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿¹²³⁰-⁹]/g;
const LINK = /(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/|api\.whatsapp\.com\/send|t\.me\/)[^\s]*|https?:\/\/[^\s]+/gi;
const LINK_LABEL = /(?:ווצאפ|וואצאפ|וואטסאפ|ווטסאפ|ווטצאפ|טלגרם)?[\s*_~:\-\p{So}\p{Extended_Pictographic}️]*(?=\u0000)/gu;
const SYMBOLS = /[*_~\p{So}\p{Extended_Pictographic}️⃣\u{1F3FB}-\u{1F3FF}]+/gu;
/** Removes invisible chars, links (with their label words) and decoration. */
const clean = (text: string) => text.replace(INVISIBLE, "").replace(LINK, "\u0000").replace(LINK_LABEL, "").replace(/\u0000/g, " ").replace(SYMBOLS, " ");
const trimLink = (raw: string) => {
  const link = raw.replace(/[*_~.,;:!?)\]]+$/, "");
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
};
const junkLink = (raw: string, filters: NoteFilter[]) => filters.some((filter) => filter.kind === "link" && filter.phrase.trim() && raw.toLowerCase().includes(filter.phrase.trim().toLowerCase()));
const matchNorm = (value: string) => value.replace(INVISIBLE, "").replace(SYMBOLS, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Drops junk links (any 'link' filter) and every line containing a 'line' filter phrase. */
export function applyNoteFilters(text: string, filters: NoteFilter[]): string {
  if (!filters.length) return text;
  const lines = filters.filter((filter) => filter.kind === "line").map((filter) => matchNorm(filter.phrase)).filter(Boolean);
  const links = filters.filter((filter) => filter.kind === "link" && filter.phrase.trim());
  return text.split(/\r?\n/)
    .filter((line) => { const norm = matchNorm(line); return !lines.some((phrase) => norm.includes(phrase)); })
    .map((line) => links.length ? line.replace(/\S+/g, (word) => junkLink(word, links) ? " " : word) : line)
    .join("\n");
}
export function extractLinks(text: string, filters: NoteFilter[] = []): { waLink: string | null; tgLink: string | null } {
  let waLink: string | null = null;
  let tgLink: string | null = null;
  for (const raw of text.replace(INVISIBLE, "").match(LINK) ?? []) {
    if (!waLink && /(?:wa\.me\/|api\.whatsapp\.com\/send)/i.test(raw)) waLink = trimLink(raw);
    else if (!tgLink && /t\.me\//i.test(raw) && !junkLink(raw, filters)) tgLink = trimLink(raw);
  }
  return { waLink, tgLink };
}
const PREFIXES = ["ו", "מ", "ל", "ב", "ה"];
const EMPTY_ALIASES: PlaceAlias[] = [];

// Count digits, not separators; never bridge lines or swallow a trailing price.
const phonePattern = () => /(?<![\d\p{L}])(?:\+?972[ \t-]*[1-9](?:[ \t-]*\d){7,8}|0[1-9](?:[ \t-]*\d){7,8})(?!\d)/gu;
export function normalizePhone(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  if (/^05\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (/^0[1-9]\d{7}$/.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return null;
}
const hasPhrase = (line: string, keywords: PhoneKeyword[], kind?: PhoneKeyword["kind"]) => keywords.some((keyword) =>
  (!kind || keyword.kind === kind) && keyword.phrase.trim() && line.includes(clean(keyword.phrase).trim()),
);

export function stripPhoneNumbers(text: string): string {
  return clean(text).replace(phonePattern(), " ");
}

/** Distribution blocks are not candidates for ride contact approval. */
export function rideTextPhones(text: string, keywords: PhoneKeyword[]): string[] {
  const phones: string[] = [];
  for (const line of clean(text).split(/\r?\n/)) {
    if (hasPhrase(line, keywords, "ignore")) break;
    for (const raw of line.match(phonePattern()) ?? []) {
      const phone = normalizePhone(raw);
      if (phone && !phones.includes(phone)) phones.push(phone);
    }
  }
  return phones;
}

/** Contact adjacency uses raw nonempty lines, never skips an intervening content line. */
function contactLines(text: string, keywords: PhoneKeyword[]): string[] {
  const lines = text.replace(INVISIBLE, "").replace(SYMBOLS, " ").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const stop = lines.findIndex(line => hasPhrase(line, keywords, "ignore"));
  return stop < 0 ? lines : lines.slice(0, stop);
}
export function extractDispatcherPhone(text: string, keywords: PhoneKeyword[]): string | null {
  const lines = contactLines(text, keywords);
  for (let i = 0; i < lines.length; i++) {
    if (!hasPhrase(lines[i] ?? "", keywords, "dispatcher")) continue;
    for (const j of [i, i + 1, i - 1]) {
      const phone = clean(lines[j] ?? "").match(phonePattern())?.[0];
      if (phone) return normalizePhone(phone);
    }
  }
  return null;
}
export function hasVerifiedDispatchLink(text: string, keywords: PhoneKeyword[], filters: NoteFilter[] = []): boolean {
  const lines = contactLines(text, keywords);
  return lines.some((line, i) => {
    const links = extractLinks(line, filters);
    return Boolean(links.waLink || links.tgLink) && [i, i + 1, i - 1].some(j => hasPhrase(lines[j] ?? "", keywords, "dispatcher"));
  });
}

type Lookup = {
  aliasMap: Map<string, PlaceAlias>;
  nameMap: Map<string, string>;
  maxWords: number;
};

// Lookups are expensive to build (thousands of official rows); cache them by
// the identity of the input arrays so re-parsing many messages stays cheap.
const lookupCache = new WeakMap<object, { official: unknown; custom: unknown; lookup: Lookup }>();

function buildLookup(options: PlaceOptions): Lookup {
  const aliases = options.aliases ?? EMPTY_ALIASES;
  const cached = lookupCache.get(aliases);
  if (cached && cached.official === options.official && cached.custom === options.custom) return cached.lookup;
  const aliasMap = new Map<string, PlaceAlias>();
  const officialKeys = new Set([...(options.official ?? []), ...(options.custom ?? [])].map(place => cityKey(place.name)));
  for (const row of aliases) {
    if (row.use_for_parse === false || ((options.official?.length ?? 0) > 0 && !officialKeys.has(cityKey(row.official_name)))) continue;
    const key = cityKey(row.alias);
    if (key && !aliasMap.has(key)) aliasMap.set(key, row);
  }
  const official = [...(options.official ?? []), ...(options.custom ?? [])];
  const nameMap = new Map<string, string>();
  for (const place of official) {
    const key = cityKey(place.name);
    if (key && !nameMap.has(key)) nameMap.set(key, place.name);
  }
  const maxWords = Math.max(3,...official.map(p=>p.name.split(/\s+/).length),...aliases.flatMap(p=>[p.alias.split(/\s+/).length,p.official_name.split(/\s+/).length]));
  const lookup: Lookup = { aliasMap, nameMap, maxWords };
  lookupCache.set(aliases, { official: options.official, custom: options.custom, lookup });
  return lookup;
}

function candidateKeys(phrase: string): string[] {
  return [cityKey(phrase), ...PREFIXES.filter((prefix) => phrase.startsWith(prefix)).map((prefix) => cityKey(phrase.slice(prefix.length)))];
}

function matchCity(words: string[], index: number, lookup: Lookup): { city: string; length: number; token: string; keepInNotes: boolean } | null {
  for (let length = Math.min(lookup.maxWords,words.length-index); length >= 1; length--) {
    if (index + length > words.length) continue;
    const token = words.slice(index, index + length).join(" ");
    for (const key of candidateKeys(token)) {
      const alias = lookup.aliasMap.get(key);
      if (alias) return { city: alias.official_name, length, token, keepInNotes: alias.keep_in_notes };
      const official = lookup.nameMap.get(key);
      if (official) return { city: official, length, token, keepInNotes: false };
    }

  }
  return null;
}

export function isValidRidePrice(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 20 && amount <= 2000 && amount % 10 === 0;
}
export function parseRide(text: string, options: PlaceOptions | PhoneKeyword[] = {}): Ride {
  const placeOptions: PlaceOptions = Array.isArray(options) ? { keywords: options } : options;
  const keywords = placeOptions.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const lookup = buildLookup(placeOptions);
  const noteFilters = placeOptions.noteFilters ?? [];
  const links = extractLinks(text, noteFilters);
  const verifiedLink = hasVerifiedDispatchLink(text, keywords, noteFilters);
  const dispatcherPhone = verifiedLink ? null : extractDispatcherPhone(text, keywords);
  // Keep an intact cleaned line for notes; use a separate token source for extraction.
  const cleanedLines = clean(applyNoteFilters(text, noteFilters)).replace(phonePattern(), " ").split(/\r?\n/)
    .filter(line => !hasPhrase(line, keywords)).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  let time: string | null = null;
  const timePattern = /(?<![\d\p{L}])(\d{1,2})[:.](\d{2})(?![\d\p{L}])/gu;
  const withoutTimes = cleanedLines.map(line => line.replace(timePattern, (match, hour: string, minute: string) => {
    if (+hour > 23 || +minute > 59) return match;
    if (time === null) time = `${hour.padStart(2, "0")}:${minute}`;
    return " ";
  }));
  let price: number | null = null;
  let explicitPrice = false;
  let invalidCandidate = false;
  const currencyPattern = /(?<![\d\p{L}])(\d+(?:\.\d+)?)\s*(?:ש["״']?ח|ש|₪)(?=$|[\s,;.!?&+])/gu;
  const barePattern = /(?<![\d\p{L}.])(\d+(?:\.\d+)?)(?![\d\p{L}.])/gu;
  // Explicit currency prices win over bare numbers, regardless of line order.
  const sources = withoutTimes.map(line => line.replace(currencyPattern, (match, amount: string) => {
    const value = Number(amount);
    if (isValidRidePrice(value)) { if (price === null) { price = value; explicitPrice = true; return " "; } return match; }
    invalidCandidate = true;
    return match;
  }));
  if (price === null) {
    for (const line of sources) {
      for (const match of line.matchAll(barePattern)) {
        const amount = Number(match[1]);
        if (isValidRidePrice(amount)) { price = amount; break; }
        if (amount >= 20 && amount <= 2000) invalidCandidate = true;
      }
      if (price !== null) break;
    }
  }
  const priceUnsure = price === null && invalidCandidate;
  let bareConsumed = false;
  const tokenLines = sources.map(line => line.replace(barePattern, (match, amount: string) => {
    if (!explicitPrice && !bareConsumed && Number(amount) === price) { bareConsumed = true; return " "; }
    return match;
  }).replace(/[,;:!?…()\[\]{}→/\\|_~&+]/g, " ").trim().split(/\s+/).filter(Boolean));
  let origin: string | null = null, destination: string | null = null;
  let originToken: string | null = null, destinationToken: string | null = null;
  const matchedCities: string[] = [], notesLines: string[] = [];
  const MARKERS = new Set(["פ", "פ'", "פ׳", "פנימי"]);
  type InternalHit = { city: string; line: number; start: number; end: number; token: string; full: boolean };
  const hits: InternalHit[] = [];
  tokenLines.forEach((words, line) => words.forEach((word, i) => {
    if (!MARKERS.has(word)) return;
    const next = matchCity(words, i + 1, lookup);
    if (next && !next.keepInNotes) hits.push({city:next.city,line,start:i,end:i+1+next.length,token:next.token,full:word === "פנימי"});
    if (word === "פנימי") {
      for (let start = Math.max(0, i - lookup.maxWords); start < i; start++) {
        const previous = matchCity(words, start, lookup);
        if (previous && !previous.keepInNotes && start + previous.length === i) {
          hits.unshift({city:previous.city,line,start,end:i+1,token:previous.token,full:true}); break;
        }
      }
    }
  }));
  const internalHit = hits.find(hit => hit.full) ?? hits[0];
  const others = new Set<string>();
  let residualWords = false;
  tokenLines.forEach((words, lineIndex) => {
    let hasNotes = false;
    for (let i = 0; i < words.length;) {
      if (internalHit && lineIndex === internalHit.line && i === internalHit.start) { i = internalHit.end; continue; }
      const word = words[i];
      if (word === undefined) break;
      const city = matchCity(words, i, lookup);
      if (city) {
        if (internalHit) {
          if (!city.keepInNotes && city.city !== internalHit.city) others.add(city.city);
          hasNotes = true;
        } else {
          matchedCities.push(city.city);
          if (origin === null) { origin = city.city; originToken = city.token; }
          else if (destination === null) { destination = city.city; destinationToken = city.token; }
          if (city.keepInNotes) { hasNotes = true; residualWords = true; }
        }
        i += city.length;
      } else {
        if (/[\p{L}\p{N}]/u.test(word)) { hasNotes = true; residualWords = true; }
        i++;
      }
    }
    if (hasNotes) notesLines.push(cleanedLines[lineIndex] ?? "");
  });
  let singlePlaceUnsure = false;
  if (internalHit) {
    origin = destination = internalHit.city;
    originToken = destinationToken = internalHit.token;
  } else if (new Set(matchedCities).size === 1) {
    if (!residualWords && price !== null) destination = origin;
    else { destination = null; singlePlaceUnsure = true; }
  }
  return {
    isRide: origin !== null || price !== null || time !== null || priceUnsure,
    origin, destination, price, time, notes: notesLines.join(" · "), notesLines,
    dispatcherPhone, originToken, destinationToken, ...links,
    internalConflict: !internalHit?.full && others.size >= 2,
    singlePlaceUnsure, priceUnsure, verifiedLink,
  };
}

/** Preferred short display form for an official place name; the shortest display alias wins. */
export function displayName(official: string | null, aliases: PlaceAlias[]): string {
  if (!official) return "";
  let best: string | null = null;
  for (const row of aliases) {
    if (row.official_name !== official || !row.is_display) continue;
    if (best === null || row.alias.length < best.length) best = row.alias;
  }
  return best ?? official;
}

/** Big-route label: the shortest hero alias, else null. */
export function heroName(official: string | null, aliases: PlaceAlias[]): string | null {
  if (!official) return null;
  let best: string | null = null;
  for (const row of aliases) {
    if (row.official_name !== official || !row.is_hero) continue;
    if (best === null || row.alias.length < best.length) best = row.alias;
  }
  return best;
}

/** 1–3 word windows from the leftover note text, longest first, capped per message. */
export function streetPhrases(ride: Ride, max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of ride.notesLines) {
    const words = line.split(/\s+/).filter((word) => /[\p{L}]/u.test(word));
    for (let length = 3; length >= 1; length--) {
      for (let i = 0; i + length <= words.length; i++) {
        const phrase = words.slice(i, i + length).join(" ");
        const key = cityKey(phrase);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(phrase);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export type StreetPick = { phrase: string; cities: string[] };

/**
 * Streets are suggestions only, including streets unique to one city; never assign a place.
 */
export function applyStreetResolution(input: {
  origin: string | null;
  destination: string | null;
  phrases: string[];
  resolve: (phrase: string) => string[] | undefined;
}): { origin: string | null; destination: string | null; picks: StreetPick[] } {
  const { origin, destination } = input;
  const picks: StreetPick[] = [];
  if (origin && destination) return { origin, destination, picks };
  for (const phrase of input.phrases) {
    const cities = input.resolve(phrase);
    if (cities?.length && !picks.some(pick => pick.phrase === phrase)) picks.push({phrase, cities});
  }
  return { origin, destination, picks };
}

export const DEFAULT_DISPLAY_TEMPLATE = "{שעה}\n{מוצא} {יעד} {מחיר}\n{הערות}\n{טלפון}";

/** Render the display-message template; empty lines are removed, double spaces collapsed. */
export function renderDisplayMessage(
  template: string,
  ride: Ride,
  info: { sender?: string | null; group?: string | null; senderPhone?: string | null; phone?: string | null; linkContact?: boolean },
  aliases: PlaceAlias[],
): string {
  const digits = (phone: string | null | undefined) => phone ? (normalizePhone(phone) ?? phone).replace(/\D/g, "") : "";
  const linkContact = info.linkContact ?? ride.verifiedLink;
  const selectedPhone = linkContact ? null : info.phone !== undefined ? info.phone : ride.dispatcherPhone ?? info.senderPhone;
  // The selected ride contact wins when both phone placeholders are in a template.
  const hasRidePhoneSlot = template.includes("{טלפון}") && Boolean(selectedPhone);
  let phoneInserted = false;
  const values: Record<string, string> = {
    "שעה": ride.time ?? "",
    "מוצא": ride.origin && ride.origin === ride.destination ? "פ " + displayName(ride.origin, aliases) : displayName(ride.origin, aliases),
    "יעד": ride.origin && ride.origin === ride.destination ? "" : displayName(ride.destination, aliases),
    "מחיר": ride.price === null ? "" : String(ride.price),
    "הערות": stripPhoneNumbers(ride.notesLines.join("\n")),
    "טלפון": digits(selectedPhone),
    "שולח": info.sender ?? "",
    "טלפון שולח": linkContact || hasRidePhoneSlot ? "" : digits(info.senderPhone),
    "קבוצה": info.group ?? "",
    "וואטסאפ": ride.waLink ?? "",
    "טלגרם": ride.tgLink ?? "",
  };
  return template
    .split("\n")
    .map((line) => line.replace(/\{(שעה|מוצא|יעד|מחיר|הערות|טלפון שולח|טלפון|שולח|קבוצה|וואטסאפ|טלגרם)\}/g, (_match, key: string) => {
      const value = values[key] ?? "";
      if (key === "טלפון" || key === "טלפון שולח") {
        if (phoneInserted || !value) return "";
        phoneInserted = true;
      }
      return value;
    }))
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Splits only for preview; callers explicitly persist children after review. */
export function splitRideBlocks(text: string, options: PlaceOptions = {}): { blocks: { text: string; ride: Ride }[]; shared: string[] } {
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) chunks.push(current.join("\n")); current = []; };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(line.trim()) && current.length && parseRide(current.join("\n"), options).price !== null) flush();
    current.push(line);
  }
  flush();
  const blocks: { text: string; ride: Ride }[] = [], shared: string[] = [];
  for (const chunk of chunks) {
    const ride = parseRide(chunk, options);
    if (ride.price !== null || ride.origin !== null) blocks.push({text:chunk,ride});
    else shared.push(chunk);
  }
  return {blocks,shared};
}
