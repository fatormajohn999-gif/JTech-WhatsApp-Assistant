import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS } from '../config.js';
import { triggerRollingSummary } from './summary.js';

export function jidToPhone(jid) {
  if (!jid) return '';
  const [user] = jid.split('@');
  return /^\d+$/.test(user) ? user : '';
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

    // Per-contact profile (updated cleanly without keyword/regex heuristics)
    const rawProfile = await redis.get(`contact:${jid}:profile`);
    let contactProf = {
      displayName: senderName || jid.split('@')[0],
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
          displayName: senderName || parsed.displayName,
          typicalMessageLength: text.length < 40 ? 'short' : (text.length < 120 ? 'medium' : 'detailed'),
          lastSeen: timestamp
        };
      } catch (_) {}
    } else {
      contactProf.typicalMessageLength = text.length < 40 ? 'short' : (text.length < 120 ? 'medium' : 'detailed');
    }

    const handoffVal = await redis.get(`handoff:${jid}`);
    const metaObj = {
      jid,
      name: senderName || contactProf.displayName || jid.split('@')[0],
      lastMessage: text.slice(0, 100),
      timestamp,
      lastRole: role,
      isHandoff: Boolean(handoffVal)
    };

    // Refresh 30-day expiry on all contact memory keys
    await Promise.all([
      redis.set(`contact:${jid}:profile`, JSON.stringify(contactProf), { ex: CONTACT_TTL_SECONDS }),
      redis.set(`chat:${jid}:meta`, JSON.stringify(metaObj), { ex: CONTACT_TTL_SECONDS }),
      redis.expire(listKey, CONTACT_TTL_SECONDS),
      redis.expire(`sum:${jid}`, CONTACT_TTL_SECONDS),
      redis.expire(`contact:${jid}:facts`, CONTACT_TTL_SECONDS),
      redis.expire(`contact:${jid}:msg_count`, CONTACT_TTL_SECONDS)
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
