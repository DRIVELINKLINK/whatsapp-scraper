import { getContentType, normalizeMessageContent } from "baileys";

const LABELS = {
  imageMessage: ["image", "📷 תמונה"],
  videoMessage: ["video", "🎬 וידאו"],
  ptvMessage: ["video", "🎬 וידאו"],
  audioMessage: ["audio", "🎵 אודיו"],
  documentMessage: ["document", "📄 מסמך"],
  documentWithCaptionMessage: ["document", "📄 מסמך"],
  stickerMessage: ["sticker", "סטיקר"],
  locationMessage: ["location", "📍 מיקום"],
  liveLocationMessage: ["location", "📍 מיקום חי"],
  contactMessage: ["vcard", "👤 איש קשר"],
  contactsArrayMessage: ["multi_vcard", "👥 אנשי קשר"],
  pollCreationMessage: ["poll_creation", "📊 סקר"],
  pollCreationMessageV2: ["poll_creation", "📊 סקר"],
  pollCreationMessageV3: ["poll_creation", "📊 סקר"],
  eventMessage: ["event_creation", "📅 אירוע"],
};

// Message kinds that carry no content for a reader (reactions, edits, deletions, key exchanges...).
const SKIP = new Set([
  "protocolMessage", "reactionMessage", "senderKeyDistributionMessage", "pollUpdateMessage",
  "messageContextInfo", "keepInChatMessage", "pinInChatMessage", "encReactionMessage",
  "encEventResponseMessage", "callLogMesssage", "newsletterAdminInviteMessage",
]);

/** Turns a Baileys message into a row for wa_messages, or null if it isn't a readable group message. */
export function toRow(msg, { account, groupName }) {
  const key = msg.key || {};
  const gid = key.remoteJid || "";
  if (!gid.endsWith("@g.us") || !key.id) return null;
  if (msg.messageStubType && !msg.message) return null; // system notices (joined, left, changed subject...)

  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const kind = getContentType(content);
  if (!kind || SKIP.has(kind)) return null;

  let type = "chat";
  let body = "";
  if (kind === "conversation") body = content.conversation || "";
  else if (kind === "extendedTextMessage") body = content.extendedTextMessage?.text || "";
  else {
    const inner = content[kind] || {};
    const [t, label] = LABELS[kind] || [kind.replace(/Message$/, ""), `[${kind.replace(/Message$/, "")}]`];
    type = t;
    if (kind === "audioMessage" && inner.ptt) { type = "ptt"; }
    let extra = inner.caption || "";
    if (!extra && (kind === "documentMessage")) extra = inner.fileName || inner.title || "";
    if (!extra && kind === "documentWithCaptionMessage") {
      const d = inner.message?.documentMessage || {};
      extra = d.caption || d.fileName || "";
    }
    if (!extra && kind.startsWith("pollCreationMessage")) extra = inner.name || "";
    if (!extra && kind === "locationMessage") extra = inner.name || inner.address || "";
    if (!extra && kind === "contactMessage") extra = inner.displayName || "";
    if (!extra && kind === "eventMessage") extra = inner.name || "";
    body = (type === "ptt" ? "🎤 הקלטה" : label) + (extra ? `: ${extra}` : "");
  }
  if (!body) return null;

  const senderId = key.participant || key.participantAlt || msg.participant || "";
  const senderName = key.fromMe ? "אני" : msg.pushName || msg.verifiedBizName || senderId.replace(/@.*$/, "") || "לא ידוע";
  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);

  return {
    id: `${gid}_${key.id}`,
    account,
    group_id: gid,
    group_name: groupName || null,
    sender: senderName,
    sender_id: senderId || null,
    sender_name: senderName,
    body,
    type,
    from_me: !!key.fromMe,
    timestamp: new Date(ts * 1000).toISOString(),
  };
}
