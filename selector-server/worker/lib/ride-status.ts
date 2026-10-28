// Copied from the WhatsApp Selector app (src/lib/ride-status.ts). Keep in sync.
import { extractDispatcherPhone, normalizePhone, rideTextPhones, type PhoneKeyword } from "./ride-parse";

export type RideStatus = "ready" | "check" | "places" | "nophone";
export type PhoneChoice = "dispatcher" | "sender";
export type RideAssessment = { status: RideStatus; phone: string | null; unconfirmedPhone: boolean; candidatePhone: string | null; checkReason: string | null };

export function assessRide(input: {
  text: string; origin: string | null; destination: string | null;
  senderPhone: string | null; keywords: PhoneKeyword[]; phoneChoice?: string | null;
  hasLink?: boolean;
  internalConflict?: boolean;
  overridePhone?: string | null;
  adminApproved?: boolean;
}): RideAssessment {
  const confirmed = extractDispatcherPhone(input.text, input.keywords);
  const candidatePhone = confirmed ?? rideTextPhones(input.text, input.keywords)[0] ?? null;
  const sender = input.senderPhone ? normalizePhone(input.senderPhone) : null;
  const manual = input.overridePhone?.trim() ? normalizePhone(input.overridePhone) ?? input.overridePhone.trim() : null;
  const approved = input.phoneChoice === "sender" || input.phoneChoice === "dispatcher" || Boolean(manual) || Boolean(input.hasLink);
  const phone = manual ?? (input.phoneChoice === "sender" ? sender
    : input.phoneChoice === "dispatcher" ? candidatePhone : confirmed ?? sender);
  const unconfirmedPhone = Boolean(candidatePhone && !confirmed && !approved && !input.adminApproved);
  const checkReason = input.adminApproved ? null : input.internalConflict ? "פנימי עם ערים נוספות" : unconfirmedPhone ? "מספר טלפון לא מאושר" : null;
  const status: RideStatus = checkReason ? "check"
    : !input.origin || !input.destination ? "places"
    : !phone && !input.hasLink ? "nophone" : "ready";
  return { status, phone, unconfirmedPhone, candidatePhone, checkReason };
}
