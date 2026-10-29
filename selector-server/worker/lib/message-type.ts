// Copied from the WhatsApp Selector app (src/lib/message-type.ts). Keep in sync.
/** Structural message row used by the pure ride files (no database imports). */
export type Message = {
  id: string; body: string | null; group_id: string | null; group_name: string | null;
  sender: string | null; sender_id: string | null; sender_name: string | null; sender_phone: string | null;
  timestamp: string | null; account: string | null; type: string | null; from_me: boolean | null;
  split_of?: string | null;
};
