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

export const REVIEW_DISMISS_AGE = 10 * 60 * 1000;
export function shouldAutoDismiss(row: {status: string; duplicate: boolean; approved: boolean; timestamp: string | null; dismissedAt?: string | null | undefined; skip?: boolean | undefined}, now: number) {
  if (row.duplicate || row.approved || row.dismissedAt || row.skip || !row.timestamp) return false;
  return ["check", "places", "nophone"].includes(row.status) && now - Date.parse(row.timestamp) >= REVIEW_DISMISS_AGE;
}
export type AutoDismissOverride = { message_id: string; dismissed_at?: string | null; auto_dismiss_skip?: boolean | null };
/** Server-side auto-removal: override rows to upsert for review rides older than REVIEW_DISMISS_AGE. */
export function autoDismissRows(
  rows: { message: { id: string; timestamp: string | null; is_duplicate: boolean }; status: string; approved?: boolean | null }[],
  overrides: AutoDismissOverride[] | ReadonlyMap<string, AutoDismissOverride>,
  now: number,
) {
  const map = overrides instanceof Map ? overrides : new Map((overrides as AutoDismissOverride[]).map(o => [o.message_id, o]));
  const iso = new Date(now).toISOString();
  return rows.filter(row => { const o = map.get(row.message.id); return shouldAutoDismiss({status:row.status,duplicate:row.message.is_duplicate,approved:Boolean(row.approved),timestamp:row.message.timestamp,dismissedAt:o?.dismissed_at,skip:o?.auto_dismiss_skip ?? false}, now); })
    .map(row => ({message_id:row.message.id,dismissed_at:iso,dismiss_kind:"auto" as const,dismiss_panel:row.status,updated_at:iso}));
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
/** Five fields only (a field missing in both rides counts as equal); needs a sender name and origin or destination. */
export function markDuplicates<T extends DuplicateRide>(rows: T[]): (T & { message: T["message"] & {is_duplicate:boolean;dup_of:string|null} })[] {
  const originals = new Map<string,string>();
  const marks = new Map<string,string|null>();
  const ordered = [...rows].sort((a,b) => {
    const time = (Date.parse(a.message.timestamp ?? "") || 0) - (Date.parse(b.message.timestamp ?? "") || 0);
    return time || (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0);
  });
  for (const row of ordered) {
    const name = row.message.sender_name?.trim();
    const contact = (row.linkContact ? row.ride.waLink ?? row.ride.tgLink : row.phone?.replace(/\D/g, "")) || null;
    if (!name || (!row.origin && !row.destination)) { marks.set(row.message.id,null); continue; }
    const price = typeof row.ride.price === "number" && Number.isFinite(row.ride.price) ? row.ride.price : null;
    const key = JSON.stringify([name,contact,row.origin ?? null,row.destination ?? null,price]);
    const original = originals.get(key);
    marks.set(row.message.id,original ?? null);
    if (!original) originals.set(key,row.message.id);
  }
  return rows.map(row => ({...row,message:{...row.message,is_duplicate:Boolean(marks.get(row.message.id)),dup_of:marks.get(row.message.id) ?? null}}));
}/** Split parents (2+ ride blocks or dismissed as split) never take part in duplicate matching. */
export function markDuplicatesExceptSplitParents<T extends DuplicateRide & { multiRides?: unknown[] | undefined }>(rows: T[], splitIds: ReadonlySet<string> = new Set()) {
  const isParent = (row: T) => (row.multiRides?.length ?? 0) >= 2 || splitIds.has(row.message.id);
  const marked = new Map(markDuplicates(rows.filter(row => !isParent(row))).map(row => [row.message.id, row]));
  return rows.map(row => marked.get(row.message.id) ?? {...row,message:{...row.message,is_duplicate:false,dup_of:null}});
}
