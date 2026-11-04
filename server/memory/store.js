import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS } from '../config.js';
import { triggerRollingSummary } from './summary.js';

const jidAliasCache = new Map();

export async function setJidAlias(aliasJid, canonicalJid) {
  if (!aliasJid || !canonicalJid || aliasJid === canonicalJid) return;
  jidAliasCache.set(aliasJid, canonicalJid);
  try {
    await redis.set(`jid:alias:${aliasJid}`, canonicalJid);
  } catch (_) {}
}

export async function normalizeJid(rawJid) {
  if (!rawJid) return '';
  const clean = String(rawJid).trim();
  const [userPart, domain] = clean.split('@');
  if (!domain) return clean;
  const baseUser = userPart.split(':')[0];
  const baseJid = `${baseUser}@${domain}`;

  if (jidAliasCache.has(baseJid)) {
    return jidAliasCache.get(baseJid);
  }

  // If it's a phone number JID, that's already the primary canonical form
  if (domain === 's.whatsapp.net' && /^\d+$/.test(baseUser)) {
    jidAliasCache.set(baseJid, baseJid);
    return baseJid;
  }

  // If it's an @lid, look up Redis alias mapping
  if (domain === 'lid') {
    try {
      const mapped = await redis.get(`jid:alias:${baseJid}`);
      if (mapped) {
        jidAliasCache.set(baseJid, mapped);
        return mapped;
      }
    } catch (_) {}
  }

  return baseJid;
}

export function jidToPhone(jid) {
  if (!jid) return '';
  const [user] = jid.split('@');
  const base = user.split(':')[0];
  return /^\d+$/.test(base) ? base : '';
}

export async function isChatPaused(jid) {
  if (!jid) return { isPaused: false };
  const canon = await normalizeJid(jid);
  try {
    const val = await redis.get(`contact:${canon}:paused`);
    if (!val) return { isPaused: false };
    if (val === 'indefinite') {
      return { isPaused: true, mode: 'indefinite', until: null };
    }
    const until = parseInt(val, 10);
    if (!isNaN(until)) {
      if (Date.now() < until) {
        return { isPaused: true, mode: 'timed', until };
      } else {
        await redis.del(`contact:${canon}:paused`);
        return { isPaused: false };
      }
    }
    return { isPaused: false };
  } catch (_) {
    return { isPaused: false };
  }
}

export async function pauseChat(jid, mode = 'indefinite') {
  const canon = await normalizeJid(jid);
  let until = null;
  let ex = undefined;

  if (mode === '1h') {
    until = Date.now() + 3600000;
    ex = 3600;
  } else if (mode === 'tomorrow') {
    // Tomorrow 08:00 Africa/Freetown (UTC+0)
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 8, 0, 0));
    until = tomorrow.getTime();
    ex = Math.max(60, Math.ceil((until - Date.now()) / 1000));
  }

  const value = until ? String(until) : 'indefinite';
  if (ex) {
    await redis.set(`contact:${canon}:paused`, value, { ex });
  } else {
    await redis.set(`contact:${canon}:paused`, value);
  }

  const metaRaw = await redis.get(`chat:${canon}:meta`);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      meta.isPaused = true;
      meta.pauseUntil = until;
      await redis.set(`chat:${canon}:meta`, JSON.stringify(meta));
    } catch (_) {}
  }
  logEvent('info', `Chat ${canon} paused (${mode}${until ? ' until ' + new Date(until).toLocaleTimeString() : ''})`);
  return { isPaused: true, mode, until };
}

export async function resumeChat(jid) {
  const canon = await normalizeJid(jid);
  await redis.del(`contact:${canon}:paused`);
  const metaRaw = await redis.get(`chat:${canon}:meta`);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      meta.isPaused = false;
      meta.pauseUntil = null;
      await redis.set(`chat:${canon}:meta`, JSON.stringify(meta));
    } catch (_) {}
  }
  logEvent('info', `Chat ${canon} resumed.`);
  return { isPaused: false };
}

export async function getResolvedContactName(rawJid) {
  const jid = await normalizeJid(rawJid);
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

export async function getChatMemory(rawJid) {
  const jid = await normalizeJid(rawJid);

  const [rawMessages, summary, rawFacts, rawProfile, rawSettings, handoffVal, pauseInfo] = await Promise.all([
    redis.lrange(`chat:${jid}:messages`, -50, -1),
    redis.get(`sum:${jid}`),
    redis.get(`contact:${jid}:facts`),
    redis.get(`contact:${jid}:profile`),
    redis.get(`contact:${jid}:settings`),
    redis.get(`handoff:${jid}`),
    isChatPaused(jid)
  ]);

  const messages = [];
  for (const item of (rawMessages || [])) {
    try {
      messages.push(JSON.parse(item));
    } catch (_) {
      messages.push({ role: 'user', text: item, timestamp: Date.now() });
    }
  }

  // Merge any older messages if rawJid was an alternate alias
  if (rawJid && rawJid !== jid) {
    try {
      const altMessages = await redis.lrange(`chat:${rawJid}:messages`, -50, -1);
      if (altMessages && altMessages.length > 0) {
        for (const it of altMessages) {
          try {
            const parsed = JSON.parse(it);
            if (!messages.some(m => m.id === parsed.id || (m.timestamp === parsed.timestamp && m.text === parsed.text))) {
              messages.push(parsed);
            }
          } catch (_) {}
        }
        messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      }
    } catch (_) {}
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
    canonicalJid: jid,
    messages,
    summary: summary || '',
    facts,
    profile,
    settings,
    isHandoff: Boolean(handoffVal),
    isPaused: Boolean(pauseInfo.isPaused),
    pauseUntil: pauseInfo.until || null
  };
}

export async function recordMessage(rawJid, role, text, fromMe = false, senderName = '') {
  try {
    const jid = await normalizeJid(rawJid);
    if (rawJid && rawJid !== jid) {
      await setJidAlias(rawJid, jid);
    }

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

    const [rawProfile, rawSettings, phonebookName, rawMeta, pauseInfo] = await Promise.all([
      redis.get(`contact:${jid}:profile`),
      redis.get(`contact:${jid}:settings`),
      redis.get(`contact:${jid}:phonebookName`),
      redis.get(`chat:${jid}:meta`),
      isChatPaused(jid)
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
      isHandoff: Boolean(handoffVal),
      isPaused: Boolean(pauseInfo.isPaused),
      pauseUntil: pauseInfo.until || null
    };

    await Promise.all([
      redis.set(`contact:${jid}:profile`, JSON.stringify(contactProf)),
      redis.set(`chat:${jid}:meta`, JSON.stringify(metaObj)),
      redis.expire(listKey, CONTACT_TTL_SECONDS),
      redis.expire(`sum:${jid}`, CONTACT_TTL_SECONDS)
    ]);

    // Update recent conversations list (max 30 canonical JIDs)
    const recentRaw = await redis.get('chats:recent');
    let recent = [];
    if (recentRaw) {
      try { recent = JSON.parse(recentRaw); } catch (_) {}
    }
    recent = recent.filter(j => j !== jid && j !== rawJid);
    recent.unshift(jid);
    if (recent.length > 30) recent = recent.slice(0, 30);
    await redis.set('chats:recent', JSON.stringify(recent));

    // Rolling Summary & Fact Extraction
    if (msgCount === 5 || msgCount % 15 === 0) {
      setImmediate(() => {
        triggerRollingSummary(jid).catch(e => console.error(`[Summary] Background task failed for ${jid}:`, e.message));
      });
    }
  } catch (err) {
    console.error(`[Memory] Error recording message for ${rawJid}:`, err.message);
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
      redis.del(`chat:${jid}:meta`),
      redis.del(`contact:${jid}:paused`)
    ]);
  }
  await redis.del('chats:recent');
  logEvent('info', 'All contact chat memory and summaries cleared.');
}
