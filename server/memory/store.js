import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS } from '../config.js';
import { triggerRollingSummary } from './summary.js';

export function jidToPhone(jid) {
  if (!jid) return '';
  const [user] = jid.split('@');
  return /^\d+$/.test(user) ? user : '';
}

export async function getResolvedContactName(jid) {
  const [rawSettings, phonebookName, rawProf, rawMeta] = await Promise.all([
    redis.get(`contact:${jid}:settings`),
    redis.get(`contact:${jid}:phonebookName`),
    redis.get(`contact:${jid}:profile`),
    redis.get(`chat:${jid}:meta`)
  ]);

  let settings = null;
  if (rawSettings) { try { settings = JSON.parse(rawSettings); } catch (_) {} }
  if (settings?.displayName) return settings.displayName;

  if (phonebookName) return phonebookName;

  let prof = null;
  if (rawProf) { try { prof = JSON.parse(rawProf); } catch (_) {} }
  if (prof?.pushName) return prof.pushName;
  if (prof?.displayName && !prof.displayName.startsWith('Owner') && prof.displayName !== 'You') {
    return prof.displayName;
  }

  let meta = null;
  if (rawMeta) { try { meta = JSON.parse(rawMeta); } catch (_) {} }
  if (meta?.name && !meta.name.startsWith('Owner') && meta.name !== 'You') return meta.name;

  const phone = jidToPhone(jid);
  return phone ? `+${phone}` : jid.split('@')[0];
}

export async function getChatMemory(jid) {
  const [rawMessages, summary, rawFacts, rawProfile, rawSettings, handoffVal] = await Promise.all([
    redis.lrange(`chat:${jid}:messages`, -50, -1),
    redis.get(`sum:${jid}`),
    redis.get(`contact:${jid}:facts`),
    redis.get(`contact:${jid}:profile`),
    redis.get(`contact:${jid}:settings`),
    redis.get(`handoff:${jid}`)
  ]);

  const messages = [];
  for (const item of (rawMessages || [])) {
    try {
      messages.push(JSON.parse(item));
    } catch (_) {
      messages.push({ role: 'user', text: item, timestamp: Date.now() });
    }
  }

  let facts = [];
  if (rawFacts) {
    try { facts = JSON.parse(rawFacts); } catch (_) {}
  }

  let profile = null;
  if (rawProfile) {
    try { profile = JSON.parse(rawProfile); } catch (_) {}
  }

  let settings = null;
  if (rawSettings) {
    try { settings = JSON.parse(rawSettings); } catch (_) {}
  }

  return {
    messages,
    summary: summary || '',
    facts,
    profile,
    settings,
    isHandoff: Boolean(handoffVal)
  };
}

export async function recordMessage(jid, role, text, fromMe = false, senderName = '') {
  try {
    const timestamp = Date.now();
    const msgObj = {
      id: `${jid}_${timestamp}_${Math.random().toString(36).substring(2, 6)}`,
      role,
      text,
      timestamp,
      fromMe,
      senderName
    };

    const listKey = `chat:${jid}:messages`;
    await redis.rpush(listKey, JSON.stringify(msgObj));
    await redis.ltrim(listKey, -50, -1);

    const msgCount = await redis.incr(`contact:${jid}:msg_count`);

    const isIncomingUser = !fromMe && role === 'user';

    // Per-contact profile (updated cleanly without keyword/regex heuristics)
    const [rawProfile, rawSettings, phonebookName, rawMeta] = await Promise.all([
      redis.get(`contact:${jid}:profile`),
      redis.get(`contact:${jid}:settings`),
      redis.get(`contact:${jid}:phonebookName`),
      redis.get(`chat:${jid}:meta`)
    ]);

    let contactProf = {
      displayName: isIncomingUser && senderName ? senderName : jid.split('@')[0],
      pushName: isIncomingUser && senderName ? senderName : '',
      preferredLanguage: 'English',
      typicalMessageLength: 'short',
      firstSeen: timestamp,
      lastSeen: timestamp
    };

    if (rawProfile) {
      try {
        const parsed = JSON.parse(rawProfile);
        contactProf = {
          ...parsed,
          pushName: (isIncomingUser && senderName) ? senderName : (parsed.pushName || ''),
          displayName: (isIncomingUser && senderName) ? senderName : (parsed.displayName || jid.split('@')[0]),
          typicalMessageLength: text.length < 40 ? 'short' : (text.length < 120 ? 'medium' : 'detailed'),
          lastSeen: timestamp
        };
      } catch (_) {}
    } else {
      contactProf.typicalMessageLength = text.length < 40 ? 'short' : (text.length < 120 ? 'medium' : 'detailed');
    }

    let parsedMeta = null;
    if (rawMeta) {
      try { parsedMeta = JSON.parse(rawMeta); } catch (_) {}
    }

    let parsedSettings = null;
    if (rawSettings) {
      try { parsedSettings = JSON.parse(rawSettings); } catch (_) {}
    }

    // Determine resolved name according to strict priority:
    // 1. Owner nickname (contact settings displayName)
    // 2. Phonebook name
    // 3. WhatsApp pushName
    // 4. Formatted phone number or jid user
    const phone = jidToPhone(jid);
    const resolvedName = (
      parsedSettings?.displayName ||
      phonebookName ||
      contactProf.pushName ||
      (isIncomingUser && senderName ? senderName : '') ||
      (parsedMeta?.name && !parsedMeta.name.startsWith('Owner') && parsedMeta.name !== 'You' ? parsedMeta.name : '') ||
      (phone ? `+${phone}` : jid.split('@')[0])
    );

    const handoffVal = await redis.get(`handoff:${jid}`);
    const metaObj = {
      jid,
      name: resolvedName,
      pushName: contactProf.pushName,
      lastMessage: text.slice(0, 100),
      timestamp,
      lastRole: role,
      fromMe: Boolean(fromMe),
      needsOwner: parsedMeta?.needsOwner || false,
      isHandoff: Boolean(handoffVal)
    };

    // Store profile & meta permanently (no 30-day expiration so contact data persists)
    await Promise.all([
      redis.set(`contact:${jid}:profile`, JSON.stringify(contactProf)),
      redis.set(`chat:${jid}:meta`, JSON.stringify(metaObj)),
      redis.expire(listKey, CONTACT_TTL_SECONDS),
      redis.expire(`sum:${jid}`, CONTACT_TTL_SECONDS)
    ]);

    // Update recent conversations list (max 30)
    const recentRaw = await redis.get('chats:recent');
    let recent = [];
    if (recentRaw) {
      try { recent = JSON.parse(recentRaw); } catch (_) {}
    }
    recent = recent.filter(j => j !== jid);
    recent.unshift(jid);
    if (recent.length > 30) recent = recent.slice(0, 30);
    await redis.set('chats:recent', JSON.stringify(recent));

    // Rolling Summary & Fact Extraction: Run in background periodically (e.g. at 5 messages, then every 15 messages)
    if (msgCount === 5 || msgCount % 15 === 0) {
      setImmediate(() => {
        triggerRollingSummary(jid).catch(e => console.error(`[Summary] Background task failed for ${jid}:`, e.message));
      });
    }
  } catch (err) {
    console.error(`[Memory] Error recording message for ${jid}:`, err.message);
  }
}


export async function clearAllMemory() {
  const recentRaw = await redis.get('chats:recent');
  let jids = [];
  if (recentRaw) {
    try { jids = JSON.parse(recentRaw); } catch (_) {}
  }

  for (const jid of jids) {
    await Promise.all([
      redis.del(`chat:${jid}:messages`),
      redis.del(`sum:${jid}`),
      redis.del(`contact:${jid}:facts`),
      redis.del(`contact:${jid}:profile`),
      redis.del(`contact:${jid}:msg_count`),
      redis.del(`chat:${jid}:meta`)
    ]);
  }
  await redis.del('chats:recent');
  logEvent('info', 'All contact chat memory and summaries cleared.');
}
