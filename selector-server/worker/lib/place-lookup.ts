// Copied from the WhatsApp Selector app (src/lib/place-lookup.ts). Keep in sync.
/** Pure automatic-alias logic (Photon). Copied verbatim by the server worker — no side-effect imports. */
import { cityKey } from "./city-match";
import { hasPhrase, keywordNorm, type NoteFilter, type PhoneKeyword, type PlaceAlias, type Ride } from "./ride-parse";

export type LookupOptions = {
  knownNames: string[]; // official + custom place names
  aliases: PlaceAlias[];
  keywords?: PhoneKeyword[];
  noteFilters?: NoteFilter[];
  skipKeys?: Set<string>; // already looked up (any status)
  max?: number;
};

const letters = (value: string) => (value.match(/\p{L}/gu) ?? []).length;

/** 1–3 word phrases from the leftover note lines that are worth a Photon lookup (max 5). */
export function lookupCandidates(ride: Pick<Ride, "notesLines">, options: LookupOptions): string[] {
  const known = new Set([...options.knownNames, ...options.aliases.map(a => a.alias)].map(cityKey));
  const filters = (options.noteFilters ?? []).map(f => keywordNorm(f.phrase)).filter(Boolean);
  const kws = options.keywords ?? [];
  const max = options.max ?? 5;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of ride.notesLines) {
    const words = line.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}'"׳״-]/gu, "")).filter(w => /\p{L}/u.test(w));
    for (let length = 3; length >= 1; length--) {
      for (let i = 0; i + length <= words.length; i++) {
        const slice = words.slice(i, i + length);
        const phrase = slice.join(" ");
        const key = cityKey(phrase);
        if (!key || seen.has(key) || letters(phrase) < 3) continue;
        seen.add(key);
        if (known.has(key) || slice.some(w => known.has(cityKey(w)))) continue;
        if (options.skipKeys?.has(key)) continue;
        if (hasPhrase(phrase, kws)) continue;
        const norm = keywordNorm(phrase);
        if (filters.some(f => norm.includes(f) || f.includes(norm))) continue;
        out.push(phrase);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export type PhotonFeature = { properties?: Record<string, unknown> };
const PLACE_VALUES = new Set(["suburb", "neighbourhood", "quarter", "locality", "hamlet", "isolated_dwelling"]);
const AMENITY_VALUES = new Set(["hospital", "university", "college", "school"]);
const TYPE_LABEL: Record<string, string> = { hospital: "בית חולים", university: "אוניברסיטה", college: "מכללה", school: "בית ספר", suburb: "שכונה", neighbourhood: "שכונה", quarter: "רובע", locality: "מקום", hamlet: "יישוב", isolated_dwelling: "מקום", aeroway: "תעופה", station: "תחנת רכבת" };

function nameMatches(phrase: string, name: string): boolean {
  const p = cityKey(phrase), n = cityKey(name);
  if (!p || !n) return false;
  if (p === n) return true;
  const strip = (s: string) => /^[ומלבה]/.test(s) ? s.slice(1) : s;
  return strip(p) === n || p === strip(n);
}
function placeType(props: Record<string, unknown>): string | null {
  const key = String(props["osm_key"] ?? ""), value = String(props["osm_value"] ?? "");
  if (key === "place" && PLACE_VALUES.has(value)) return TYPE_LABEL[value] ?? value;
  if (key === "amenity" && AMENITY_VALUES.has(value)) return TYPE_LABEL[value] ?? value;
  if (key === "aeroway") return TYPE_LABEL["aeroway"] ?? key;
  if (key === "railway" && value === "station") return TYPE_LABEL["station"] ?? value;
  if ((key === "building" || key === "landuse") && props["name"]) return key === "building" ? "מבנה" : "אזור";
  return null;
}

/** Accept a Photon feature only when its name equals the phrase, it is a place inside a city, and that city is known. */
export function photonPick(phrase: string, features: PhotonFeature[], officialNames: string[]): { official_name: string; detail: string } | null {
  const byKey = new Map(officialNames.map(n => [cityKey(n), n]));
  for (const feature of features) {
    const props = feature.properties ?? {};
    const name = typeof props["name"] === "string" ? props["name"] : "";
    if (!name || !nameMatches(phrase, name)) continue;
    const type = placeType(props);
    if (!type) continue;
    const city = [props["city"], props["locality"], props["district"], props["county"]].find((v): v is string => typeof v === "string" && Boolean(v.trim()));
    const official = city ? byKey.get(cityKey(city)) : undefined;
    if (!official) continue;
    return { official_name: official, detail: `${name} · ${type} · ${official}` };
  }
  return null;
}

/** Row to insert for an automatic alias, or null when any alias with the same key exists (manual always wins). */
export function autoAliasRow(phrase: string, pick: { official_name: string; detail: string }, existing: { alias: string }[]) {
  const key = cityKey(phrase);
  if (existing.some(a => cityKey(a.alias) === key)) return null;
  return { alias: phrase, official_name: pick.official_name, auto_detail: pick.detail, use_for_parse: true, keep_in_notes: true, is_display: false, is_hero: false, source: "auto" as const };
}
