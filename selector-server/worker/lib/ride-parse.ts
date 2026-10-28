// Copied from the WhatsApp Selector app (src/lib/ride-parse.ts). Keep in sync.
import { cityKey, type CityRow } from "./city-match";

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
  internalConflict: boolean;
};

export const DEFAULT_PHONE_KEYWORDS: PhoneKeyword[] = [
  ...["לבקש פה", "לבקש במס", "לבקש ב", "לפנות למס", "לפנות ל", "להתקשר", "לתיאום"].map((phrase) => ({ phrase, kind: "dispatcher" as const })),
  ...["מספרי הפצה", "לצרף", "צרפו"].map((phrase) => ({ phrase, kind: "ignore" as const })),
];

export type PlaceOptions = {
  aliases?: PlaceAlias[] | undefined;
  official?: OfficialPlace[] | undefined;
  sheet?: CityRow[] | undefined;
  keywords?: PhoneKeyword[] | undefined;
  noteFilters?: NoteFilter[] | undefined;
};

const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿¹²³⁰-⁹]/g;
const LINK = /(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/|api\.whatsapp\.com\/send|t\.me\/)[^\s]*|https?:\/\/[^\s]+/gi;
const LINK_LABEL = /(?:ווצאפ|וואצאפ|וואטסאפ|ווטסאפ|ווטצאפ|טלגרם)?[\s*_~:\-\p{So}\p{Extended_Pictographic}️]*(?=\u0000)/gu;
const SYMBOLS = /[*_~\p{So}\p{Extended_Pictographic}️⃣\u{1F3FB}-\u{1F3FF}]+/gu;
const clean = (text: string) => text.replace(INVISIBLE, "").replace(LINK, "\u0000").replace(LINK_LABEL, "").replace(/\u0000/g, " ").replace(SYMBOLS, " ");
const trimLink = (raw: string) => {
  const link = raw.replace(/[*_~.,;:!?)\]]+$/, "");
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
};
const junkLink = (raw: string, filters: NoteFilter[]) => filters.some((filter) => filter.kind === "link" && filter.phrase.trim() && raw.toLowerCase().includes(filter.phrase.trim().toLowerCase()));
const matchNorm = (value: string) => value.replace(INVISIBLE, "").replace(SYMBOLS, "").replace(/\s+/g, " ").trim().toLowerCase();
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

export function extractDispatcherPhone(text: string, keywords: PhoneKeyword[]): string | null {
  const lines = clean(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (hasPhrase(line, keywords, "ignore")) break;
    if (!hasPhrase(line, keywords, "dispatcher")) continue;
    for (let j = i; j <= i + 2 && j < lines.length; j++) {
      const candidate = lines[j];
      if (candidate === undefined) continue;
      if (hasPhrase(candidate, keywords, "ignore")) break;
      const phone = candidate.match(phonePattern())?.[0];
      if (phone) return normalizePhone(phone);
    }
  }
  return null;
}

type Lookup = {
  aliasMap: Map<string, PlaceAlias>;
  nameMap: Map<string, string>;
};

const lookupCache = new WeakMap<object, { official: unknown; sheet: unknown; lookup: Lookup }>();

function buildLookup(options: PlaceOptions): Lookup {
  const aliases = options.aliases ?? EMPTY_ALIASES;
  const cached = lookupCache.get(aliases);
  if (cached && cached.official === options.official && cached.sheet === options.sheet) return cached.lookup;
  const aliasMap = new Map<string, PlaceAlias>();
  for (const row of aliases) {
    if (row.use_for_parse === false) continue;
    const key = cityKey(row.alias);
    if (key && !aliasMap.has(key)) aliasMap.set(key, row);
  }
  const official = options.official ?? [];
  const sheet = options.sheet ?? [];
  const nameMap = new Map<string, string>();
  for (const place of official) {
    const key = cityKey(place.name);
    if (key && !nameMap.has(key)) nameMap.set(key, place.name);
  }
  for (const row of sheet) {
    const key = cityKey(row.name);
    if (key && !nameMap.has(key)) nameMap.set(key, row.name);
  }
  const lookup: Lookup = { aliasMap, nameMap };
  lookupCache.set(aliases, { official: options.official, sheet: options.sheet, lookup });
  return lookup;
}

function candidateKeys(phrase: string): string[] {
  return [cityKey(phrase), ...PREFIXES.filter((prefix) => phrase.startsWith(prefix)).map((prefix) => cityKey(phrase.slice(prefix.length)))];
}

function matchCity(words: string[], index: number, lookup: Lookup): { city: string; length: number; token: string; keepInNotes: boolean } | null {
  for (const length of [3, 2, 1]) {
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

export function parseRide(text: string, options: PlaceOptions | PhoneKeyword[] = {}): Ride {
  const placeOptions: PlaceOptions = Array.isArray(options) ? { keywords: options } : options;
  const keywords = placeOptions.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const lookup = buildLookup(placeOptions);
  const dispatcherPhone = extractDispatcherPhone(text, keywords);
  const noteFilters = placeOptions.noteFilters ?? [];
  const links = extractLinks(text, noteFilters);
  let source = clean(applyNoteFilters(text, noteFilters)).replace(phonePattern(), " ");
  let time: string | null = null;
  source = source.replace(/(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)/g, (match, hour: string, minute: string) => {
    if (+hour > 23 || +minute > 59) return match;
    if (time === null) time = `${hour.padStart(2, "0")}:${minute}`;
    return " ";
  });
  let price: number | null = null;
  source = source.replace(/(?<!\d)(\d+(?:\.\d+)?)\s*(?:ש["״']?ח|ש|₪)(?=$|[\s,;.!?])/g, (_match, amount: string) => {
    if (price === null) price = Number(amount);
    return " ";
  });
  let origin: string | null = null;
  let destination: string | null = null;
  let originToken: string | null = null;
  let destinationToken: string | null = null;
  const matchedCities: string[] = [];
  const notesLines: string[] = [];
  const MARKERS = new Set(["פ", "פ'", "פ׳", "פנימי"]);
  const lines = source.split(/\r?\n/).filter((line) => !hasPhrase(line, keywords)).map((line) => line.replace(/[,;:!?…()\[\]{}→/\\|_~]/g, " ").trim().split(/\s+/).filter(Boolean));
  let internal: { city: string; line: number; index: number; token: string } | null = null;
  lines.forEach((words, line) => words.forEach((word, i) => {
    if (internal || !MARKERS.has(word)) return;
    const next = matchCity(words, i + 1, lookup);
    if (next && !next.keepInNotes) internal = { city: next.city, line, index: i, token: next.token };
  }));
  const internalHit = internal as { city: string; line: number; index: number; token: string } | null;
  const others = new Set<string>();
  lines.forEach((words, lineIndex) => {
    const leftover: string[] = [];
    for (let i = 0; i < words.length;) {
      const word = words[i];
      if (word === undefined) break;
      if (internalHit && lineIndex === internalHit.line && i === internalHit.index) {
        const next = matchCity(words, i + 1, lookup);
        i += 1 + (next?.length ?? 0);
        continue;
      }
      if (word === "פנימי") { i++; continue; }
      const city = matchCity(words, i, lookup);
      if (city) {
        if (internalHit) {
          if (!city.keepInNotes && city.city !== internalHit.city) others.add(city.city);
          leftover.push(city.token);
        } else {
          matchedCities.push(city.city);
          if (origin === null) { origin = city.city; originToken = city.token; }
          else if (destination === null) { destination = city.city; destinationToken = city.token; }
          if (city.keepInNotes) leftover.push(city.token);
        }
        i += city.length;
        continue;
      }
      if (price === null && /^\d+(?:\.\d+)?$/.test(word) && Number(word) >= 50) {
        price = Number(word);
      } else if (/[\p{L}\p{N}]/u.test(word) && !/^(?:₪|ש["״']?ח|ש)$/.test(word)) {
        leftover.push(word);
      }
      i++;
    }
    if (leftover.length) notesLines.push(leftover.join(" "));
  });
  if (internalHit) {
    origin = destination = internalHit.city;
    originToken = destinationToken = internalHit.token;
  } else {
    const distinct = [...new Set(matchedCities)];
    if (distinct.length === 1 && distinct[0] !== undefined) { origin = distinct[0]; destination = distinct[0]; }
  }
  return {
    isRide: origin !== null || price !== null || time !== null,
    origin,
    destination,
    price,
    time,
    notes: notesLines.join(" · "),
    notesLines,
    dispatcherPhone,
    originToken,
    destinationToken,
    waLink: links.waLink,
    tgLink: links.tgLink,
    internalConflict: others.size >= 2,
  };
}

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

export function applyStreetResolution(input: {
  origin: string | null;
  destination: string | null;
  phrases: string[];
  resolve: (phrase: string) => string[] | undefined;
}): { origin: string | null; destination: string | null; picks: StreetPick[] } {
  let { origin, destination } = input;
  const picks: StreetPick[] = [];
  if (origin && destination) return { origin, destination, picks };
  const found = new Set<string>([origin, destination].filter((city): city is string => Boolean(city)));
  for (const phrase of input.phrases) {
    if (origin && destination) break;
    const cities = input.resolve(phrase);
    if (!cities || !cities.length) continue;
    if (cities.length === 1) {
      const city = cities[0];
      if (city === undefined) continue;
      if (!origin) origin = city;
      else if (!destination && city !== origin) destination = city;
      found.add(city);
    } else if (!picks.some((pick) => pick.phrase === phrase)) {
      picks.push({ phrase, cities });
    }
  }
  const distinct = [...found];
  if (!picks.length && distinct.length === 1 && distinct[0] !== undefined) {
    origin = distinct[0];
    destination = distinct[0];
  }
  return { origin, destination, picks };
}
