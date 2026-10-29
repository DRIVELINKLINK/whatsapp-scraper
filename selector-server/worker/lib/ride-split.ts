// Copied from the WhatsApp Selector app (src/lib/ride-split.ts). Keep in sync.
import { DEFAULT_PHONE_KEYWORDS, hasPhrase, parseRide, removePhones, rideTextPhones, splitRideBlocks, type PlaceOptions } from './ride-parse';
import type { Message } from './message-type';

/**
 * Contact per ride block: its own phone; else the message's only phone; else a shared
 * phone directly before/after the block or closer to it than to any other block.
 * Numbers after an "ignore" keyword are never candidates. null → stays in check.
 */
export function blockContacts(body: string, options: PlaceOptions): (string | null)[] {
  const keywords = options.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const { blocks, sharedParts } = splitRideBlocks(body, options);
  const all = rideTextPhones(body, keywords);
  const candidates: { phone: string; line: number }[] = [];
  for (const part of sharedParts) {
    if (part.ignored) continue;
    part.text.split("\n").forEach((line, k) => { for (const phone of rideTextPhones(line, keywords)) candidates.push({ phone, line: part.start + k }); });
  }
  const dist = (b: { start: number; end: number }, line: number) => line < b.start ? b.start - line : line > b.end ? line - b.end : 0;
  return blocks.map((block, i) => {
    const own = rideTextPhones(block.text, keywords)[0];
    if (own) return own;
    if (all.length === 1) return all[0] ?? null;
    let best: { phone: string; d: number } | null = null;
    for (const c of candidates) {
      const d = dist(block, c.line);
      const others = blocks.filter((_b, j) => j !== i).map(b => dist(b, c.line));
      if ((d <= 1 || others.every(o => d < o)) && (!best || d < best.d)) best = { phone: c.phone, d };
    }
    return best?.phone ?? null;
  });
}

export function splitMessageRows(parent: Message, options: PlaceOptions) {
  const source = parent.body ?? '';
  const {blocks,sharedParts} = splitRideBlocks(source,options);
  if (blocks.length < 2) return [];
  const keywords = options.keywords ?? DEFAULT_PHONE_KEYWORDS;
  const phones = rideTextPhones(source,keywords);
  const contacts = blockContacts(source,options);
  const parentRide = parseRide(source,options);
  const marker = source.split(/\r?\n/).find(line => hasPhrase(line,keywords,'dispatcher')) ? keywords.find(k=>k.kind==='dispatcher' && source.split(/\r?\n/).some(line=>hasPhrase(line,[k],'dispatcher')))?.phrase : null;
  // Shared notes go to every child; their phones are re-attached per block below; distribution text is dropped.
  const shared = sharedParts.filter(part=>!part.ignored).map(part=>removePhones(part.text).split('\n').filter(line=>line.trim()).join('\n')).filter(Boolean);
  return blocks.map((block,i) => {
    let body = [block.text,...shared].join('\n');
    if(parentRide.verifiedLink && phones.length<=1 && !block.ride.waLink && !block.ride.tgLink && !rideTextPhones(block.text,keywords).length) {
      const links=[parentRide.waLink,parentRide.tgLink].filter((link):link is string=>Boolean(link)&&!body.includes(link??''));
      if(links.length)body += `\n${[marker,...links].filter(Boolean).join('\n')}`;
    }
    const contact = contacts[i] ?? null;
    if (contact && !rideTextPhones(body,keywords).includes(contact)) body += `\n${marker ?? 'לבקש פה'}\n${contact}`;
    return {id:`${parent.id}#${i+1}`,split_of:parent.id,body,group_id:parent.group_id,group_name:parent.group_name,sender:parent.sender,sender_id:parent.sender_id,sender_name:parent.sender_name,sender_phone:parent.sender_phone,timestamp:parent.timestamp,account:parent.account,type:parent.type,from_me:parent.from_me};
  });
}

/** Server auto-split: child rows for a message with 2+ real ride blocks, else []. Never re-splits a child. */
export function autoSplitRows(parent: Message, options: PlaceOptions) {
  if (parent.split_of || parent.id.includes('#')) return [];
  return splitMessageRows(parent, options);
}
