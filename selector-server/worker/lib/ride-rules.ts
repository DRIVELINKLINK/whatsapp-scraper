// Copied from the WhatsApp Selector app (src/lib/ride-rules.ts). Keep in sync.
export type RideFilter = "all" | "phone" | "no-phone" | "duplicates" | "internal";
export function classifyRide(row: { isRide: boolean; origin: string | null; destination: string | null; duplicate: boolean }) {
  if (!row.isRide) return "ignore";
  if (row.duplicate) return "duplicate";
  return row.origin && row.destination ? "board" : "review";
}
export function matchesRideFilter(row: { origin: string | null; destination: string | null; dispatcherPhone: string | null }, filter: RideFilter) {
  if (filter === "phone") return Boolean(row.dispatcherPhone);
  if (filter === "no-phone") return !row.dispatcherPhone;
  if (filter === "internal") return Boolean(row.origin && row.origin === row.destination);
  return true;
}
export function groupApproval(enabled: boolean) {
  return { enabled, archived: !enabled, pending_review: false };
}

export const REVIEW_DISMISS_AGE = 30 * 60 * 1000;
export function shouldAutoDismiss(row: {status: string; duplicate: boolean; approved: boolean; timestamp: string | null; dismissedAt?: string | null | undefined; skip?: boolean | undefined}, now: number) {
  if (row.duplicate || row.approved || row.dismissedAt || row.skip || !row.timestamp) return false;
  return ["check", "places", "nophone"].includes(row.status) && now - Date.parse(row.timestamp) >= REVIEW_DISMISS_AGE;
}
export const manualDismissPatch = (now: string) => ({dismissed_at: now, dismiss_kind: "manual" as const, updated_at: now});
export const restoreDismissPatch = {dismissed_at: null, auto_dismiss_skip: true};
export function dismissalList(kind: string | null, dismissedAt: string | null) {
  return !dismissedAt || kind === "split" ? null : kind === "auto" ? "auto" : "manual";
}

export type DuplicateRide = {
  message: { id: string; timestamp: string | null; sender_name: string | null };
  origin: string | null; destination: string | null; phone: string | null;
  linkContact?: boolean; ride: { price: number | null; waLink: string | null; tgLink: string | null };
};
/** Five known fields only; no legacy flags, group, text or age participates. */
export function markDuplicates<T extends DuplicateRide>(rows: T[]): (T & { message: T["message"] & {is_duplicate:boolean;dup_of:string|null} })[] {
  const originals = new Map<string,string>();
  const marks = new Map<string,string|null>();
  const ordered = [...rows].sort((a,b) => {
    const time = (Date.parse(a.message.timestamp ?? "") || 0) - (Date.parse(b.message.timestamp ?? "") || 0);
    return time || (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0);
  });
  for (const row of ordered) {
    const name = row.message.sender_name?.trim();
    const contact = row.linkContact ? row.ride.waLink ?? row.ride.tgLink : row.phone?.replace(/\D/g, "");
    if (!name || !contact || !row.origin || !row.destination || row.ride.price === null || !Number.isFinite(row.ride.price)) { marks.set(row.message.id,null); continue; }
    const key = JSON.stringify([name,contact,row.origin,row.destination,row.ride.price]);
    const original = originals.get(key);
    marks.set(row.message.id,original ?? null);
    if (!original) originals.set(key,row.message.id);
  }
  return rows.map(row => ({...row,message:{...row.message,is_duplicate:Boolean(marks.get(row.message.id)),dup_of:marks.get(row.message.id) ?? null}}));
}
