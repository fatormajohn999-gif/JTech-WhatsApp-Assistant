import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS } from '../config.js';
import { triggerRollingSummary } from './summary.js';
import { extractContactFacts } from './facts.js';

export function jidToPhone(jid) {
  if (!jid) return '';
  const [user] = jid.split('@');
  return /^\d+$/.test(user) ? user : '';
}

export function isPersonalMessage(text) {
  if (!text) return false;
  const personalWords = /\b(my name|i live|i work|my birthday|my phone|my email|i am|i'm|i work at|my job|my age|my address|i study|my school|my college|my university|my wife|my husband|my daughter|my son|my brother|my sister)\b/i;
  const phonePattern = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}\b/;
  const datePattern = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
  return personalWords.test(text) || phonePattern.test(text) || datePattern.test(text);
}

export function detectContactLanguage(text, existingLang = 'English') {
  const lower = (text || '').toLowerCase();
  const isKrio = /\b(kusheh|wetin|dey|una|leki|aw de go|di|ba|pikin|sef|krio|salone|na|dem|wetin dey)\b/i.test(lower);
  return isKrio ? 'Krio' : existingLang;
}

export async function getChatMemory(jid) {
  const [rawMessages, summary, rawFacts, rawProfile, handoffVal] = await Promise.all([
    redis.lrange(`chat:${jid}:messages`, -50, -1),
    redis.get(`sum:${jid}`),
    redis.get(`contact:${jid}:facts`),
    redis.get(`contact:${jid}:profile`),
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

  return {
    messages,
    summary: summary || '',
    facts,
    profile,
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

    // Update per-contact profile
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
          preferredLanguage: detectContactLanguage(text, parsed.preferredLanguage),
          typicalMessageLength: text.length < 40 ? 'short' : (text.length < 120 ? 'medium' : 'detailed'),
          lastSeen: timestamp
        };
      } catch (_) {}
    } else {
      contactProf.preferredLanguage = detectContactLanguage(text, 'English');
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

    // Rolling Summary: Every 20 messages, run non-blocking in background
    if (msgCount % 20 === 0) {
      setImmediate(() => {
        triggerRollingSummary(jid).catch(e => console.error(`[Summary] Background task failed for ${jid}:`, e.message));
      });
    }

    // Fact Extraction: During personal messages, run non-blocking in background
    if (role === 'user' && isPersonalMessage(text)) {
      setImmediate(() => {
        extractContactFacts(jid, text).catch(e => console.error(`[Facts] Error extracting for ${jid}:`, e.message));
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
