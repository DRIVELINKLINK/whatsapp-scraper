// Copied from the WhatsApp Selector app (src/lib/ride-status.ts). Keep in sync.
import { extractDispatcherPhone, normalizePhone, rideTextPhones, type PhoneKeyword } from "./ride-parse";

export type RideStatus = "ready" | "check" | "places" | "nophone";
export type PhoneChoice = "dispatcher" | "sender";
export type RideAssessment = { status: RideStatus; phone: string | null; unconfirmedPhone: boolean; candidatePhone: string | null; checkReason: string | null; linkContact: boolean };

export function assessRide(input: {
  text: string; origin: string | null; destination: string | null;
  senderPhone: string | null; keywords: PhoneKeyword[]; phoneChoice?: string | null;
  /** wa.me / t.me dispatch link present: counts as a dispatcher contact. */
  hasLink?: boolean;
  multiRideCount?: number;
  inheritedPhoneAmbiguous?: boolean;
   verifiedLink?: boolean;
   singlePlaceUnsure?: boolean;
   priceUnsure?: boolean;
   notesLineCount?: number;
  internalConflict?: boolean;
  /** Admin-entered phone; wins over everything. */
  overridePhone?: string | null;
  /** Admin approval: the ride is never "check" again. */
  adminApproved?: boolean;
}): RideAssessment {
  const confirmed = extractDispatcherPhone(input.text, input.keywords);
  const candidatePhone = confirmed ?? rideTextPhones(input.text, input.keywords)[0] ?? null;
  const sender = input.senderPhone ? normalizePhone(input.senderPhone) : null;
  const manual = input.overridePhone?.trim() ? normalizePhone(input.overridePhone) ?? input.overridePhone.trim() : null;
  const linkContact = Boolean(input.hasLink && (input.verifiedLink || input.adminApproved));
  const approved = input.phoneChoice === "sender" || input.phoneChoice === "dispatcher" || Boolean(manual) || linkContact;
  const phone = linkContact ? null : manual ?? (input.phoneChoice === "sender" ? sender
    : input.phoneChoice === "dispatcher" ? candidatePhone : confirmed ?? sender);
  const unconfirmedPhone = Boolean(candidatePhone && !confirmed && !approved && !input.adminApproved);
  const checkReason = (input.multiRideCount ?? 0) >= 2 ? `${input.multiRideCount} נסיעות בהודעה אחת — לפרק` : input.adminApproved ? null
    : input.inheritedPhoneAmbiguous ? "מספר טלפון לא מאושר"
    : input.hasLink && !linkContact ? "קישור לא מאומת כסדרן"
    : input.internalConflict ? "פנימי עם ערים נוספות"
    : input.singlePlaceUnsure ? "מקום אחד ומילים נוספות — לא ודאי שפנימי"
    : input.priceUnsure ? "מחיר לא עגול / לא ודאי"
    : (input.notesLineCount ?? 0) > 6 ? `הערות ארוכות (${input.notesLineCount} שורות) — לבדוק מילות סינון`
    : unconfirmedPhone ? "מספר טלפון לא מאושר" : null;
  const status: RideStatus = checkReason ? "check"
    : !input.origin || !input.destination ? "places"
    : !phone && !linkContact ? "nophone" : "ready";
  return { status, phone, unconfirmedPhone, candidatePhone, checkReason, linkContact };
}

export type RideStatusFilter = RideStatus | "duplicates" | "internal";
export function matchesStatusFilter(row: { message: { is_duplicate: boolean }; status: RideStatus; origin: string | null; destination: string | null }, filter: RideStatusFilter | null) {
  if (filter === "duplicates") return row.message.is_duplicate;
  if (row.message.is_duplicate) return false;
  if (filter === "internal") return Boolean(row.origin && row.origin === row.destination);
  return filter ? row.status === filter : row.status !== "ready";
}
