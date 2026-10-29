// Copied from the WhatsApp Selector app (src/lib/drivelink.ts). Keep in sync.
import { placeLabel, renderRideNotes, type PlaceAlias, type Ride, type RideNotesInfo } from "./ride-parse";
/** Pure DriveLink mapping + push logic (no secrets here; the server fn supplies them). */
export type DriveLinkRide = {
  source_ref: string; pickup_city: string; dest_city: string; pickup_city_display: string; dest_city_display: string; pickup_address: string; ride_at: string;
  price: number | null; notes: string; dispatcher_name: string; phone: string; wa_link: string | null; tg_link: string | null;
  group_name: string; original_text: string;
  passengers: number | null; luggage: number | null; female_driver: boolean;
};
export type PushResult = { source_ref: string; ok: boolean; ride_number?: number | undefined; duplicate?: boolean | undefined; error?: string | undefined };
export const MAX_RIDES_PER_CALL = 20;
export const MAX_ATTEMPTS = 5;

/** Ride time on the message's date; if it is >30 min before the message, the next day. No time → message timestamp. */
export function rideAt(time: string | null, messageIso: string | null): string {
  const base = messageIso && Number.isFinite(Date.parse(messageIso)) ? new Date(messageIso) : new Date();
  const match = time?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return base.toISOString();
  const at = new Date(base);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (at.getTime() < base.getTime() - 30 * 60_000) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

export type MappableRide = {
  message: { id: string; body: string | null; timestamp: string | null; sender_name: string | null; sender_phone?: string | null; split_of?: string | null };
  ride: { price: number | null; time: string | null; notesLines: string[]; waLink: string | null; tgLink: string | null; passengers?: number | null; luggage?: number | null; femaleDriver?: boolean };
  groupName: string; origin: string | null; destination: string | null; phone: string | null; pickupAddress?: string;
  linkContact?: boolean; streets?: string[]; splitPart?: string | null;
};
export type DriveLinkOptions = { notesTemplate?: string | null; aliases?: PlaceAlias[] };
const stripNoise = (line: string) => line
  .replace(/(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|t\.me|chat\.whatsapp\.com)\/\S*/gi, "")
  .replace(/https?:\/\/\S+/gi, "")
  .replace(/\+?\d[\d\s-]{7,}\d/g, "")
  .replace(/\s+/g, " ").trim();

/** Notes from the notes template (when given), else the cleaned note lines. */
export function driveLinkNotes(row: MappableRide, options: DriveLinkOptions = {}): string {
  if (!options.notesTemplate) return row.ride.notesLines.map(stripNoise).filter(Boolean).join("\n");
  const ride = { originToken: null, destinationToken: null, dispatcherPhone: null, verifiedLink: false, passengers: null, luggage: null, femaleDriver: false, ...row.ride, origin: row.origin, destination: row.destination ?? row.origin } as unknown as Ride;
  const info: RideNotesInfo = { sender: row.message.sender_name, senderPhone: row.message.sender_phone ?? null, phone: row.phone, group: row.groupName, pickupAddress: row.pickupAddress ?? null, streets: row.streets ?? [], messageTime: row.message.timestamp, splitPart: row.splitPart ?? null, originalText: row.message.body };
  if (row.linkContact !== undefined) info.linkContact = row.linkContact;
  return renderRideNotes(options.notesTemplate, ride, info, options.aliases ?? []);
}

export function toDriveLinkRide(row: MappableRide, options: DriveLinkOptions = {}): DriveLinkRide {
  const origin = row.origin ?? "";
  const dest = row.destination ?? origin;
  const aliases = options.aliases ?? [];
  return {
    source_ref: row.message.id,
    pickup_city: origin,
    dest_city: dest,
    pickup_city_display: placeLabel(origin || null, aliases) || origin,
    dest_city_display: placeLabel(dest || null, aliases) || dest,
    pickup_address: row.pickupAddress ?? "",
    ride_at: rideAt(row.ride.time, row.message.timestamp),
    price: typeof row.ride.price === "number" && Number.isFinite(row.ride.price) ? row.ride.price : null,
    notes: driveLinkNotes(row, options),
    dispatcher_name: row.message.sender_name ?? "",
    phone: (row.phone ?? "").replace(/\D/g, ""),
    wa_link: row.ride.waLink,
    tg_link: row.ride.tgLink,
    group_name: row.groupName,
    original_text: row.message.body ?? "",
    passengers: row.ride.passengers ?? null,
    luggage: row.ride.luggage ?? null,
    female_driver: row.ride.femaleDriver ?? false,
  };
}

export async function pushRides(rides: DriveLinkRide[], url: string, key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<PushResult[]> {
  const results: PushResult[] = [];
  for (const ride of rides.slice(0, MAX_RIDES_PER_CALL)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-intake-key": key }, body: JSON.stringify(ride), signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as { ride_number?: unknown; duplicate?: unknown; error?: unknown };
      const rideNumber = typeof payload.ride_number === "number" ? payload.ride_number : Number(payload.ride_number) || undefined;
      const duplicate = payload.duplicate === true || response.status === 409;
      if (response.ok || duplicate) results.push({ source_ref: ride.source_ref, ok: true, ride_number: rideNumber, duplicate });
      else results.push({ source_ref: ride.source_ref, ok: false, error: typeof payload.error === "string" ? `HTTP ${response.status}: ${payload.error}` : `HTTP ${response.status}` });
    } catch (error) {
      results.push({ source_ref: ride.source_ref, ok: false, error: controller.signal.aborted ? "timeout" : error instanceof Error ? error.message : "network error" });
    } finally { clearTimeout(timer); }
  }
  return results;
}

const HOUR = 60 * 60_000;
/** Auto mode: only rides that arrived after auto mode was turned on and whose ride time is not >60 min past. */
export function autoEligible(row: MappableRide, since: string | null, now = Date.now()): boolean {
  if (!since || !row.message.timestamp) return false;
  if (Date.parse(row.message.timestamp) < Date.parse(since)) return false;
  return Date.parse(rideAt(row.ride.time, row.message.timestamp)) >= now - HOUR;
}
/** Manual bulk send: rides from the last 2 hours whose ride time is not >60 min past. */
export function manualEligible(row: MappableRide, now = Date.now()): boolean {
  if (!row.message.timestamp || Date.parse(row.message.timestamp) < now - 2 * HOUR) return false;
  return Date.parse(rideAt(row.ride.time, row.message.timestamp)) >= now - HOUR;
}
