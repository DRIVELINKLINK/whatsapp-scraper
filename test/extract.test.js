import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "http://localhost:1";
process.env.SUPABASE_KEY ||= "x";

const { toRow } = await import("../src/extract.js");

const base = (message, extra = {}) => ({
  key: { remoteJid: "123@g.us", id: "ABC", participant: "555@lid", fromMe: false },
  message, pushName: "יצחק", messageTimestamp: 1793026833, ...extra,
});

test("plain text", () => {
  const r = toRow(base({ conversation: "שלום" }), { account: "main", groupName: "קבוצה א" });
  assert.equal(r.id, "123@g.us_ABC");
  assert.equal(r.body, "שלום");
  assert.equal(r.type, "chat");
  assert.equal(r.sender, "יצחק");
  assert.equal(r.group_name, "קבוצה א");
  assert.equal(r.account, "main");
  assert.equal(r.timestamp, new Date(1793026833000).toISOString());
});

test("extended text and image caption", () => {
  assert.equal(toRow(base({ extendedTextMessage: { text: "קישור" } }), { account: "a" }).body, "קישור");
  const img = toRow(base({ imageMessage: { caption: "חדש" } }), { account: "a" });
  assert.equal(img.type, "image");
  assert.equal(img.body, "📷 תמונה: חדש");
});

test("voice note, document, poll", () => {
  assert.equal(toRow(base({ audioMessage: { ptt: true } }), { account: "a" }).body, "🎤 הקלטה");
  assert.equal(toRow(base({ documentMessage: { fileName: "a.pdf" } }), { account: "a" }).body, "📄 מסמך: a.pdf");
  assert.equal(toRow(base({ pollCreationMessageV3: { name: "מתי?" } }), { account: "a" }).body, "📊 סקר: מתי?");
});

test("wrapped (ephemeral) message is unwrapped", () => {
  const r = toRow(base({ ephemeralMessage: { message: { conversation: "נעלם" } } }), { account: "a" });
  assert.equal(r.body, "נעלם");
});

test("skips non-group, reactions, protocol and empty", () => {
  assert.equal(toRow({ ...base({ conversation: "x" }), key: { remoteJid: "1@s.whatsapp.net", id: "1" } }, { account: "a" }), null);
  assert.equal(toRow(base({ reactionMessage: { text: "👍" } }), { account: "a" }), null);
  assert.equal(toRow(base({ protocolMessage: { type: 0 } }), { account: "a" }), null);
  assert.equal(toRow(base(null, { messageStubType: 20 }), { account: "a" }), null);
});

test("own messages are labelled", () => {
  const r = toRow(base({ conversation: "x" }, { key: { remoteJid: "1@g.us", id: "Z", fromMe: true } }), { account: "a" });
  assert.equal(r.sender, "אני");
  assert.equal(r.from_me, true);
});
