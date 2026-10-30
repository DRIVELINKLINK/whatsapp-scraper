// Copied from the WhatsApp Selector app (src/lib/ride-parse.ts). Keep in sync.
import { cityKey } from "./city-match";

export type PhoneKeyword = { phrase: string; kind: "dispatcher" | "ignore" };
export type PlaceAlias = { alias: string; official_name: string; is_display: boolean; keep_in_notes: boolean; use_for_parse?: boolean; is_hero?: boolean };
export type NoteFilter = { phrase: string; kind: "line" | "link" | "label" };
export type ParseWordKind = "passengers" | "luggage" | "female" | "internal";
export type ParseWord = { kind: ParseWordKind | string; phrase: string };
export type OfficialPlace = { code: string; name: string };
export type Ride = {
  isRide: boolean;
  origin: string | null;
  destination: string | null;
  price: number | null;
  passengers: number | null;
  luggage: number | null;
  femaleDriver: boolean;
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
  /** One known place only; internal was inferred without a פ marker (verify with resolveSinglePlace). */
  singlePlaceInferred: boolean;
  priceUnsure: boolean;
  verifiedLink: boolean;
};

export const DEFAULT_PHONE_KEYWORDS: PhoneKeyword[] = [
  ...["לבקש פה", "לבקש במס", "לבקש ב", "לפנות למס", "לפנות ל", "להתקשר", "לתיאום"].map((phrase) => ({ phrase, kind: "dispatcher" as const })),
  ...["מספרי הפצה", "מספר הפצה", "לצרף", "צרפו"].map((phrase) => ({ phrase, kind: "ignore" as const })),
];

export type PlaceOptions = {
  aliases?: PlaceAlias[] | undefined;
  official?: OfficialPlace[] | undefined;
  custom?: { name: string }[] | undefined;
  keywords?: PhoneKeyword[] | undefined;
  noteFilters?: NoteFilter[] | undefined;
  /** Admin-editable recognition words (wa_parse_words); a missing/empty kind uses today's words. */
  parseWords?: ParseWord[] | undefined;
};

const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿¹²³⁰-⁹]/g;
const LINK = /(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/|api\.whatsapp\.com\/send|t\.me\/)[^\s]*|https?:\/\/[^\s]+/gi;
/** Default "word before a link" labels (note filters of kind 'label'). */
export const DEFAULT_LINK_LABELS = ["ווצאפ", "וואצאפ", "וואטסאפ", "ווטסאפ", "ווטצאפ", "טלגרם"];
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelPattern = (labels: string[]) => new RegExp(`(?:${labels.map(escapeRe).join("|")})?[\\s*_~:\\-\\p{So}\\p{Extended_Pictographic}\\uFE0F]*(?=\\u0000)`, "gu");
const DEFAULT_LINK_LABEL = labelPattern(DEFAULT_LINK_LABELS);
const labelCache = new Map<string, RegExp>();
/** Label regex for the 'label' note filters; the 6 default words when none are given. */
function linkLabel(filters: NoteFilter[] | undefined): RegExp {
  const labels = [...new Set((filters ?? []).filter(f => f.kind === "label").map(f => f.phrase.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!labels.length) return DEFAULT_LINK_LABEL;
  const key = labels.join("\u0001");
  let re = labelCache.get(key);
  if (!re) { re = labelPattern(labels); labelCache.set(key, re); }
  return re;
}
const SYMBOLS = /[*_~\p{So}\p{Extended_Pictographic}️⃣\u{1F3FB}-\u{1F3FF}]+/gu;
/** Notes/display cleaning: removes invisible chars, links (with their label words) and decoration. */
const clean = (text: string, label: RegExp = DEFAULT_LINK_LABEL) => text.replace(INVISIBLE, "").replace(LINK, "\u0000").replace(label, "").replace(/\u0000/g, " ").replace(SYMBOLS, " ");
/** Detection cleaning: keeps every word (labels included); strips invisible chars, links and symbols only. */
const cleanKeep = (text: string) => text.replace(INVISIBLE, "").replace(LINK, " ").replace(SYMBOLS, " ");
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
/** Fallback distribution markers, used only when the keyword list has no "ignore" phrases (they live in the DB now). */
export const BUILTIN_IGNORE_PHRASES = ["מספרי הפצה", "מספר הפצה", "לצרף", "צרפו"];
/** Symbols, asterisks, emoji and repeated spaces never affect keyword matching; label words are kept. */
export const keywordNorm = (value: string) => cleanKeep(value).replace(/[^\p{L}\p{N}\s'"׳״]/gu, " ").replace(/\s+/g, " ").trim();
const phraseHit = (line: string, phrase: string) => { const p = keywordNorm(phrase); return Boolean(p) && ` ${keywordNorm(line)} `.includes(p); };
/** Fallback only: off as soon as the keyword list itself holds any of these ignore phrases (the DB rows). */
const builtinIgnoreActive = (keywords: PhoneKeyword[]) => !keywords.some(k => k.kind === "ignore" && BUILTIN_IGNORE_PHRASES.includes(keywordNorm(k.phrase)));
export function hasPhrase(line: string, keywords: PhoneKeyword[], kind?: PhoneKeyword["kind"]): boolean {
  if ((!kind || kind === "ignore") && builtinIgnoreActive(keywords) && BUILTIN_IGNORE_PHRASES.some(phrase => phraseHit(line, phrase))) return true;
  return keywords.some((keyword) => (!kind || keyword.kind === kind) && phraseHit(line, keyword.phrase));
}
/** Phone from a wa.me / api.whatsapp.com link (972… → 05…), else null. */
export function linkPhone(link: string | null | undefined): string | null {
  if (!link || !/(?:wa\.me\/|api\.whatsapp\.com\/send)/i.test(link)) return null;
  const digits = link.match(/wa\.me\/\+?(\d{9,13})/i)?.[1] ?? link.match(/[?&]phone=\+?(\d{9,13})/i)?.[1];
  return digits ? normalizePhone(digits) : null;
}
/** Removes phone numbers from a raw line, leaving link lines untouched. */
export function removePhones(text: string): string {
  return text.split(/\r?\n/).map(line => LINK.test(line) ? (LINK.lastIndex = 0, line) : line.replace(phonePattern(), " ").replace(/[ \t]+$/,"")).join("\n");
}

export function stripPhoneNumbers(text: string): string {
  return clean(text).replace(phonePattern(), " ");
}

/** Distribution blocks are not candidates for ride contact approval. */
export function rideTextPhones(text: string, keywords: PhoneKeyword[]): string[] {
  const phones: string[] = [];
  for (const line of cleanKeep(text).split(/\r?\n/)) {
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
      const phone = cleanKeep(lines[j] ?? "").match(phonePattern())?.[0];
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
export const DEFAULT_PARSE_WORDS: Record<ParseWordKind, string[]> = {
  passengers: ["מקומות", "מקום", "נוסעים", "נוסע", "מק'", "מק׳", "מק’"],
  luggage: ["מזוודות", "מזוודה", "מזוודה גדולה", "ג", "ק"],
  female: ["נהגת"],
  internal: ["פ", "פ'", "פ׳", "פנימי"],
};
type WordRules = { passenger: RegExp; luggage: RegExp; female: RegExp; markers: Set<string>; fullMarkers: Set<string>; restPassenger: RegExp; restLuggage: RegExp; restFemale: RegExp; restInternal: RegExp };
const letters = (word: string) => (word.match(/\p{L}/gu) ?? []).length;
const alt = (words: string[]) => [...words].sort((a, b) => b.length - a.length).map(w => escapeRe(w).replace(/\s+/g, "\\s+")).join("|");
// Today's exact patterns: the default behaviour stays byte-for-byte identical.
const DEFAULT_RULES: WordRules = {
  passenger: /(?<![\d\p{L}])(?:(\d+)\s*(?:מקומות|מקום|נוסעים|נוסע|מק['׳’])|(?:נוסע|מקום)\s+אחד)(?![\p{L}\d])/gu,
  luggage: /(?<![\d\p{L}])(?:(\d+)\s*מזוודות|מזוודה(?:\s+גדולה)?|(\d+)\s*[גק])(?![\p{L}\d])/gu,
  female: /(?<![\p{L}])נהגת(?![\p{L}])/u,
  markers: new Set(DEFAULT_PARSE_WORDS.internal), fullMarkers: new Set(["פנימי"]),
  restPassenger: /(?<![\d\p{L}])(?:\d+\s*(?:מקומות|מקום|נוסעים|נוסע|מק['׳’])|(?:נוסע|מקום)\s+אחד|נוסעת\s+אחת)(?![\p{L}\d])/gu,
  restLuggage: /(?<![\d\p{L}])(?:\d+\s*מזוודות|מזוודה(?:\s+גדולה)?|\d+\s*[גק])(?![\p{L}\d])/gu,
  restFemale: /(?<![\p{L}])נהגת(?![\p{L}])/gu,
  restInternal: /(?<![\p{L}])(?:פנימי|פ['׳]?)(?![\p{L}])/gu,
};
const rulesCache = new WeakMap<object, WordRules>();
/** Recognition rules from wa_parse_words; each empty/missing kind falls back to today's words. */
export function wordRules(parseWords: ParseWord[] | undefined): WordRules {
  if (!parseWords?.length) return DEFAULT_RULES;
  const cached = rulesCache.get(parseWords);
  if (cached) return cached;
  const of = (kind: ParseWordKind) => [...new Set(parseWords.filter(w => w.kind === kind).map(w => w.phrase.trim()).filter(Boolean))];
  const p = of("passengers"), l = of("luggage"), f = of("female"), m = of("internal");
  const rules: WordRules = { ...DEFAULT_RULES };
  if (p.length) {
    rules.passenger = new RegExp(`(?<![\\d\\p{L}])(?:(\\d+)\\s*(?:${alt(p)})|(?:${alt(p)})\\s+אחד)(?![\\p{L}\\d])`, "gu");
    rules.restPassenger = new RegExp(`(?<![\\d\\p{L}])(?:\\d+\\s*(?:${alt(p)})|(?:${alt(p)})\\s+אחד|נוסעת\\s+אחת)(?![\\p{L}\\d])`, "gu");
  }
  if (l.length) {
    const long = l.filter(w => letters(w) >= 2);
    const alone = long.length ? `|(?:${alt(long)})` : "";
    rules.luggage = new RegExp(`(?<![\\d\\p{L}])(?:(\\d+)\\s*(?:${alt(l)})${alone})(?![\\p{L}\\d])`, "gu");
    rules.restLuggage = new RegExp(`(?<![\\d\\p{L}])(?:\\d+\\s*(?:${alt(l)})${alone})(?![\\p{L}\\d])`, "gu");
  }
  if (f.length) { rules.female = new RegExp(`(?<![\\p{L}])(?:${alt(f)})(?![\\p{L}])`, "u"); rules.restFemale = new RegExp(`(?<![\\p{L}])(?:${alt(f)})(?![\\p{L}])`, "gu"); }
  if (m.length) {
    rules.markers = new Set(m); rules.fullMarkers = new Set(m.filter(w => letters(w) >= 2));
    rules.restInternal = new RegExp(`(?<![\\p{L}])(?:${alt(m)})(?![\\p{L}])`, "gu");
  }
  rulesCache.set(parseWords, rules);
  return rules;
}
/** Metadata is extracted independently; its numbers are masked only in price scanning. */
export function rideExtras(text: string, options: Pick<PlaceOptions, "parseWords"> = {}) {
  const rules = wordRules(options.parseWords);
  const normalized = clean(text);
  let passengers: number | null = null;
  let luggage: number | null = null;
  const firstNumber = (groups: unknown[]) => { const n = groups.find((g): g is string => typeof g === "string" && /^\d+$/.test(g)); return n === undefined ? null : Number(n); };
  const masked = normalized.replace(rules.passenger, (match: string, ...groups: unknown[]) => {
    passengers ??= firstNumber(groups) ?? 1; return " ".repeat(match.length);
  }).replace(rules.luggage, (match: string, ...groups: unknown[]) => {
    luggage = (luggage ?? 0) + (firstNumber(groups) ?? 1); return " ".repeat(match.length);
  });
  return { passengers, luggage, femaleDriver: rules.female.test(normalized), masked };
}
export function parseRide(text: string, options: PlaceOptions | PhoneKeyword[] = {}): Ride {
  const placeOptions: PlaceOptions = Array.isArray(options) ? { keywords: options } : options;
  const keywords = placeOptions.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const lookup = buildLookup(placeOptions);
  const noteFilters = placeOptions.noteFilters ?? [];
  const rules = wordRules(placeOptions.parseWords);
  const label = linkLabel(noteFilters);
  const links = extractLinks(text, noteFilters);
  const { passengers, luggage, femaleDriver } = rideExtras(text, placeOptions);
  const verifiedLink = hasVerifiedDispatchLink(text, keywords, noteFilters);
  const dispatcherPhone = verifiedLink ? null : extractDispatcherPhone(text, keywords);
  // Keep an intact cleaned line for notes; use a separate token source for extraction.
  const cleanedLines = clean(applyNoteFilters(text, noteFilters), label).replace(phonePattern(), " ").split(/\r?\n/)
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
  const priceLines = withoutTimes.map(line => rideExtras(line, placeOptions).masked);
  let selectedBare: { line: number; index: number; raw: string } | null = null;
  let priceLine: number | null = null;
  const sources = priceLines.map((line, li) => line.replace(currencyPattern, (match, amount: string) => {
    const value = Math.floor(Number(amount) / 10 + 0.5) * 10;
    if (isValidRidePrice(value)) { if (price === null) { price = value; explicitPrice = true; priceLine = li; return " "; } return match; }
    invalidCandidate = true;
    return match;
  }));
  if (price === null) {
    for (const [lineIndex, line] of sources.entries()) {
      const words = line.replace(/[,;:!?…()\[\]{}→/\\|_~&+]/g, " ").trim().split(/\s+/);
      if (!words.some((_word, index) => matchCity(words, index, lookup))) continue;
      for (const match of line.matchAll(barePattern)) {
        const amount = Math.floor(Number(match[1]) / 10 + 0.5) * 10;
        if (isValidRidePrice(amount)) { price = amount; priceLine = lineIndex; selectedBare = {line:lineIndex,index:match.index,raw:match[0]}; break; }
      }
      if (price !== null) break;
    }
  }
  const priceUnsure = price === null && invalidCandidate;
  // Extraction masks must not erase passenger/luggage notes or residual-word safety.
  let currencyConsumed = false;
  const tokenLines = withoutTimes.map((line, lineIndex) => line.replace(currencyPattern, (match, amount: string) => {
    if (explicitPrice && !currencyConsumed && Math.floor(Number(amount)/10+0.5)*10 === price) { currencyConsumed=true; return " "; }
    return match;
  }).replace(barePattern, (match, _amount: string, offset: number) => {
    if (!explicitPrice && selectedBare?.line === lineIndex && selectedBare.raw === match && priceLines[lineIndex]?.slice(offset,offset+match.length) === match) {
      // Only consume the chosen occurrence (metadata masks preserve offsets below).
      if (offset === selectedBare.index) return " ";
    }
    return match;
  }).replace(/[,;:!?…()\[\]{}→/\\|_~&+]/g, " ").trim().split(/\s+/).filter(Boolean));
  let origin: string | null = null, destination: string | null = null;
  let originLine: number | null = null, destinationLine: number | null = null;
  let originToken: string | null = null, destinationToken: string | null = null;
  const matchedCities: string[] = [], notesLines: string[] = [];
  const MARKERS = rules.markers;
  type InternalHit = { city: string; line: number; start: number; end: number; token: string; full: boolean };
  const hits: InternalHit[] = [];
  tokenLines.forEach((words, line) => words.forEach((word, i) => {
    if (!MARKERS.has(word)) return;
    const next = matchCity(words, i + 1, lookup);
    const full = rules.fullMarkers.has(word);
    if (next && !next.keepInNotes) hits.push({city:next.city,line,start:i,end:i+1+next.length,token:next.token,full});
    if (full) {
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
          if (origin === null) { origin = city.city; originToken = city.token; originLine = lineIndex; }
          else if (destination === null) { destination = city.city; destinationToken = city.token; destinationLine = lineIndex; }
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
  let singlePlaceInferred = false;
  if (internalHit) {
    origin = destination = internalHit.city;
    originToken = destinationToken = internalHit.token;
  } else if (new Set(matchedCities).size === 1) {
    // One known place in the whole message: internal, extra words allowed (streets checked by resolveSinglePlace).
    if (price !== null) { destination = origin; singlePlaceInferred = residualWords; }
    else { destination = null; singlePlaceUnsure = true; }
  } else if (originLine !== null && destinationLine !== null && originLine !== destinationLine && priceLine === originLine) {
    // Ride line has one place; the other place sits on another line — do not guess.
    destination = null; destinationToken = null; singlePlaceUnsure = true;
  }
  return {
    isRide: origin !== null || price !== null || time !== null || priceUnsure,
    origin, destination, price, passengers, luggage, femaleDriver, time, notes: notesLines.join(" · "), notesLines,
    dispatcherPhone, originToken, destinationToken, ...links,
    internalConflict: !internalHit?.full && others.size >= 2,
    singlePlaceUnsure, singlePlaceInferred, priceUnsure, verifiedLink,
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

export type RideBlockPart = { text: string; start: number; end: number };
/**
 * Splits a message into ride blocks (origin or price) and shared parts. A part with an
 * "ignore" keyword and everything after it is distribution text: shared, never a ride.
 * start/end are indices among nonblank lines.
 */
export function splitRideBlocks(text: string, options: PlaceOptions = {}): { blocks: (RideBlockPart & { ride: Ride })[]; shared: string[]; sharedParts: (RideBlockPart & { ignored: boolean })[] } {
  const keywords = options.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const chunks: RideBlockPart[] = [];
  let current: string[] = [];
  let index = 0;
  const flush = () => { if (current.length) chunks.push({ text: current.join("\n"), start: index - current.length, end: index - 1 }); current = []; };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(line.trim()) && current.length && parseRide(current.join("\n"), options).price !== null) flush();
    current.push(line); index++;
  }
  flush();
  const blocks: (RideBlockPart & { ride: Ride })[] = [], sharedParts: (RideBlockPart & { ignored: boolean })[] = [];
  let ignored = false;
  for (const chunk of chunks) {
    ignored ||= chunk.text.split("\n").some(line => hasPhrase(line, keywords, "ignore"));
    const ride = ignored ? null : parseRide(chunk.text, options);
    if (ride && (ride.price !== null || ride.origin !== null)) blocks.push({ ...chunk, ride });
    else sharedParts.push({ ...chunk, ignored });
  }
  return { blocks, shared: sharedParts.map(part => part.text), sharedParts };
}

/**
 * Verifies an inferred single-place internal ride against the street index:
 * a leftover phrase that is a street only in other cities (not the origin) means "check".
 */
export function resolveSinglePlace(ride: Ride, origin: string | null, resolve: (phrase: string) => string[] | undefined): { destination: string | null; unsure: boolean } {
  if (!origin || !ride.singlePlaceInferred) return { destination: ride.destination, unsure: ride.singlePlaceUnsure };
  const elsewhere = streetPhrases(ride).some(phrase => { const cities = resolve(phrase); return Boolean(cities?.length) && !cities!.includes(origin); });
  return elsewhere ? { destination: null, unsure: true } : { destination: origin, unsure: false };
}

/** Display label for a place: Hero alias ?? display alias ?? official. */
export function placeLabel(official: string | null, aliases: PlaceAlias[]): string {
  if (!official) return "";
  return heroName(official, aliases) ?? displayName(official, aliases);
}

/** Hebrew error when `alias` as Hero for `official` collides with another place's Hero name; else null. */
export function heroConflict(alias: string, official: string, aliases: PlaceAlias[]): string | null {
  const key = cityKey(alias);
  const other = aliases.find((row) => row.is_hero && row.official_name !== official && cityKey(row.alias) === key);
  return other ? `השם "${alias}" כבר מוגדר כענק של "${other.official_name}" — שני מקומות שונים לא יכולים לקבל אותו שם ענק` : null;
}

export const DEFAULT_NOTES_TEMPLATE = "{שעה} {מוצא} {יעד} {מחיר}\n{שאר ההודעה}";
export const NOTES_PLACEHOLDERS = ["שעה","מוצא","יעד","מוצא רשמי","יעד רשמי","מחיר","סוג","מקומות","מזוודות","נהגת","כתובת איסוף","רחובות","שאר ההודעה","שולח","טלפון","טלפון שולח","קבוצה","וואטסאפ","טלגרם","תאריך","שעת הודעה","מספר בפירוק","טקסט מקורי"] as const;

/** Note lines without the recognized places, price, time, phones, links and passenger/luggage/נהגת words. */
export function restOfMessage(ride: Pick<Ride, "notesLines" | "originToken" | "destinationToken" | "price">, options: Pick<PlaceOptions, "parseWords" | "noteFilters"> = {}): string {
  const tokens = [ride.originToken, ride.destinationToken].filter((t): t is string => Boolean(t)).sort((a, b) => b.length - a.length);
  const rules = wordRules(options.parseWords);
  const extraPatterns = [rules.restPassenger, rules.restLuggage, rules.restFemale];
  const label = linkLabel(options.noteFilters);
  return ride.notesLines.map((raw) => {
    let line = clean(raw, label).replace(phonePattern(), " ");
    line = line.replace(/(?<![\d\p{L}])\d{1,2}[:.]\d{2}(?![\d\p{L}])/gu, " ");
    for (const pattern of extraPatterns) line = line.replace(pattern, " ");
    if (ride.price !== null) line = line.replace(new RegExp(`(?<![\\d\\p{L}])${ride.price}(?:\\s*(?:ש["״']?ח|ש|₪))?(?![\\d\\p{L}])`, "gu"), " ");
    line = line.replace(/₪/g, " ");
    for (const token of tokens) line = line.replace(new RegExp(`(?<![\\p{L}])[ולמבה]?${escapeRe(token)}(?![\\p{L}])`, "gu"), " ");
    line = line.replace(rules.restInternal, " ");
    return line.replace(/[,;:!?…()\[\]{}→/\\|_~&+\-–]+/g, " ").replace(/\s+/g, " ").trim();
  }).filter((line) => /[\p{L}\p{N}]/u.test(line)).join("\n");
}

export type RideNotesInfo = {
  sender?: string | null; group?: string | null; senderPhone?: string | null; phone?: string | null; linkContact?: boolean;
  pickupAddress?: string | null; streets?: string[]; messageTime?: string | null; splitPart?: string | null; originalText?: string | null;
};
/** Render the notes template; empty placeholders disappear, empty lines removed, double spaces collapsed. */
export function renderRideNotes(template: string, ride: Ride, info: RideNotesInfo, aliases: PlaceAlias[], options: Pick<PlaceOptions, "parseWords" | "noteFilters"> = {}): string {
  const digits = (phone: string | null | undefined) => phone ? (normalizePhone(phone) ?? phone).replace(/\D/g, "") : "";
  const internal = Boolean(ride.origin && ride.origin === ride.destination);
  const linkContact = info.linkContact ?? ride.verifiedLink;
  const phone = linkContact ? "" : digits(info.phone !== undefined ? info.phone : ride.dispatcherPhone ?? info.senderPhone);
  const at = info.messageTime && Number.isFinite(Date.parse(info.messageTime)) ? new Date(info.messageTime) : null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const streets = [...new Set([...(info.pickupAddress ? [info.pickupAddress] : []), ...(info.streets ?? [])])];
  const values: Record<string, string> = {
    "שעה": ride.time ?? "",
    "מוצא": placeLabel(ride.origin, aliases),
    "יעד": internal ? "" : placeLabel(ride.destination, aliases),
    "מוצא רשמי": ride.origin ?? "",
    "יעד רשמי": ride.destination ?? "",
    "מחיר": ride.price === null ? "" : String(ride.price),
    "סוג": ride.origin && ride.destination ? (internal ? "פנימי" : "בין עירוני") : "",
    "מקומות": ride.passengers != null ? `${ride.passengers} מקומות` : "",
    "מזוודות": ride.luggage != null ? `${ride.luggage} מזוודות` : "",
    "נהגת": ride.femaleDriver ? "נהגת" : "",
    "כתובת איסוף": info.pickupAddress ?? "",
    "רחובות": streets.join(", "),
    "שאר ההודעה": restOfMessage(ride, options),
    "שולח": info.sender ?? "",
    "טלפון": phone,
    "טלפון שולח": linkContact ? "" : digits(info.senderPhone),
    "קבוצה": info.group ?? "",
    "וואטסאפ": ride.waLink ?? "",
    "טלגרם": ride.tgLink ?? "",
    "תאריך": at ? `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}` : "",
    "שעת הודעה": at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : "",
    "מספר בפירוק": info.splitPart ?? "",
    "טקסט מקורי": info.originalText ?? "",
  };
  const keys = [...NOTES_PLACEHOLDERS].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  return template.replace(new RegExp(`\\{(${keys})\\}`, "g"), (_m, key: string) => values[key] ?? "")
    .split("\n").map((line) => line.replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean).join("\n");
}

/** "2/3" for split children (deterministic parent#N ids). */
export function splitPart(id: string, splitOf: string | null | undefined, total: number): string | null {
  if (!splitOf) return null;
  const n = Number(id.slice(id.lastIndexOf("#") + 1));
  return Number.isFinite(n) && n > 0 ? `${n}/${Math.max(total, n)}` : null;
}

/** Every single-word key that can start or belong to a known place name/alias (superset for the pre-check). */
export function placeWordKeys(options: PlaceOptions): Set<string> {
  const keys = new Set<string>();
  const names = [...(options.official ?? []).map(p => p.name), ...(options.custom ?? []).map(p => p.name), ...(options.aliases ?? []).map(a => a.alias)];
  for (const name of names) for (const word of name.split(/[\s\-–־]+/)) { const key = cityKey(word); if (key) keys.add(key); }
  return keys;
}
/** Cheap pre-check: text with no digit and no known place word can never be a ride (skips parseRide). */
export function mightBeRide(text: string, placeKeys: Set<string>): boolean {
  if (/\d/.test(text)) return true;
  if (!placeKeys.size) return true;
  for (const word of text.split(/[^\p{L}'"׳״]+/u)) {
    const key = cityKey(word);
    if (!key) continue;
    if (placeKeys.has(key) || placeKeys.has(key.slice(1)) || placeKeys.has(key.slice(2))) return true;
  }
  return false;
}
