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
export type CityRow = { name: string; keys: string[]; fallback: string[] };
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
/** Sheet rows: A = name, B = English, H (index 7) = aliases; C/D/E fallback only. */
export function sheetToRows(csv: string): CityRow[] {
  const out: CityRow[] = [];
  for (const r of parseCsv(csv).slice(1)) {
    const name = (r[0] ?? "").replace(/\s+/g, " ").trim(); if (!name) continue;
    const keys = [name, r[1] ?? "", ...(r[7] ?? "").split(/[,;]/)].map(cityKey).filter(Boolean);
    const fallback = [r[2], r[3], r[4]].map((v) => cityKey(v ?? "")).filter(Boolean);
    out.push({ name, keys, fallback });
  }
  return out;
}
