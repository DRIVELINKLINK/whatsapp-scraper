// Copied from the WhatsApp Selector app (src/lib/city-match.ts). Keep in sync.
const EN_TO_HE: Record<string, string> = {
  q: "/", w: "'", e: "ק", r: "ר", t: "א", y: "ט", u: "ו", i: "ן", o: "ם", p: "פ",
  a: "ש", s: "ד", d: "ג", f: "כ", g: "ע", h: "י", j: "ח", k: "ל", l: "ך", ";": "ף",
  z: "ז", x: "ס", c: "ב", v: "ה", b: "נ", n: "מ", m: "צ", ",": "ת", ".": "ץ",
};
const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
export function cityKey(s: string): string {
  return s.toLowerCase().replace(/[​-‏﻿]/g, "").replace(/[ךםןףץ]/g, (c) => FINALS[c] ?? c)
    .replace(/["'״׳]/g, "").replace(/[^\p{L}\p{N}]/gu, "").replace(/(.)\1+/gu, "$1");
}
export function enKeyboardToHe(s: string): string | null {
  if (!/^[a-z;,.\s']+$/i.test(s.trim())) return null;
  return s.toLowerCase().replace(/[a-z;,.]/g, (c) => EN_TO_HE[c] ?? c);
}
export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}
export type CityRow = { name: string; keys: string[]; fallback: string[] };
export function queryKeys(q: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const k = cityKey(s); if (!k) return; out.add(k);
    if (/^[למבהוכש]/.test(k) && k.length > 3) out.add(k.slice(1));
    if (/^(מה|לה|וה|ול|ומ|וב|שה|של|במ)/.test(k) && k.length > 4) out.add(k.slice(2));
  };
  add(q); const he = enKeyboardToHe(q); if (he) add(he);
  return [...out];
}
function scoreKey(qk: string, k: string): number {
  if (!k) return 0;
  if (qk === k) return 100;
  if (k.startsWith(qk)) return qk.length >= 2 ? 80 - Math.min(10, k.length - qk.length) : 0;
  if (qk.length >= 3) {
    const max = qk.length >= 7 ? 2 : 1; const d = levenshtein(qk, k, max);
    if (d <= max) return 65 - d * 5;
    if (k.includes(qk)) return 40;
  }
  return 0;
}
export function matchCities(rows: CityRow[], q: string, limit = 15) {
  const qks = queryKeys(q); if (!qks.length) return [];
  const best = new Map<string, number>();
  const run = (pick: (r: CityRow) => string[]) => {
    for (const r of rows) { let s = 0; for (const k of pick(r)) for (const qk of qks) s = Math.max(s, scoreKey(qk, k)); if (s > (best.get(r.name) ?? 0)) best.set(r.name, s); }
  };
  run((r) => r.keys);
  if (!best.size || Math.max(...best.values()) === 0) run((r) => r.fallback.filter((f) => f === qks[0]));
  const list = [...best.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  const top = list[0]?.[1] ?? 0; const tied = list.filter(([, s]) => s === top).length;
  return list.slice(0, limit).map(([name, score], i) => ({ name, score, auto: i === 0 && tied === 1 && (score === 100 || (score >= 55 && score < 70)) }));
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
