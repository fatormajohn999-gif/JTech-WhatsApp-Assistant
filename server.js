/**
 * JTech Assistant - server.js
 * 
 * Production-ready WhatsApp AI assistant backend for JTech.
 * - Node 20+, ES modules, Express with CORS & Vary: Origin
 * - @whiskeysockets/baileys (linked device, pairing code login, no QR)
 * - @upstash/redis REST (automaticDeserialization: false)
 * - Dual AI: Google Gemini & Groq with 12s timeout & automatic fallback
 * - Sensitive topics guardrail (money, passwords, appointments, promises -> personal handoff)
 * - Owner human reply detection (silences bot for 10 minutes when owner replies personally)
 * - Multi-turn conversational history: alternating user/assistant turns sent to Gemini & Groq
 * - Rolling summary (every 20 messages, merged up to 600 chars) & background fact extraction
 * - Per-contact profile (last seen timing, preferred language, typical message length)
 * - 30-day rolling TTL on all contact memory keys
 * - Token-based authentication (POST /api/login, Authorization: Bearer <token>, x-pass header)
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { Redis } from '@upstash/redis';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Loud warning if DASHBOARD_PASSWORD is not configured
if (!DASHBOARD_PASSWORD) {
  console.error('****************************************************************');
  console.error(' [SECURITY WARNING] DASHBOARD_PASSWORD environment variable is NOT set!');
  console.error(' All dashboard logins and password-protected API routes will be refused.');
  console.error(' Set DASHBOARD_PASSWORD in your environment before using the dashboard.');
  console.error('****************************************************************');
}

// 30-day contact key TTL in seconds (refreshes on every message)
const CONTACT_TTL_SECONDS = 30 * 24 * 60 * 60; // 2,592,000 seconds

// ---------------------------------------------------------------------------
// 1. Resilient Redis REST Layer (automaticDeserialization: false)
// ---------------------------------------------------------------------------
class UpstashStore {
  constructor() {
    this.isUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN && !UPSTASH_URL.includes('your-database'));
    if (this.isUpstash) {
      try {
        this.client = new Redis({
          url: UPSTASH_URL,
          token: UPSTASH_TOKEN,
          automaticDeserialization: false
        });
        console.log('[Redis] Connected to Upstash Redis REST (automaticDeserialization: false)');
      } catch (err) {
        console.error('[Redis] Upstash init error, falling back to local memory store:', err.message);
        this.client = null;
        this.isUpstash = false;
      }
    } else {
      console.warn('[Redis] No valid UPSTASH_REDIS_REST_URL / TOKEN. Running with in-memory store.');
      this.client = null;
    }
    this.memory = new Map();
  }

  async get(key) {
    try {
      if (this.isUpstash && this.client) {
        const val = await this.client.get(key);
        return val === null ? null : String(val);
      }
    } catch (e) {
      console.error(`[Redis] GET error for ${key}:`, e.message);
    }
    return this.memory.has(key) ? this.memory.get(key) : null;
  }

  async set(key, value, options = {}) {
    try {
      const strVal = typeof value === 'string' ? value : JSON.stringify(value);
      if (this.isUpstash && this.client) {
        if (options.ex) {
          await this.client.set(key, strVal, { ex: options.ex });
        } else {
          await this.client.set(key, strVal);
        }
        return 'OK';
      }
      this.memory.set(key, strVal);
      return 'OK';
    } catch (e) {
      console.error(`[Redis] SET error for ${key}:`, e.message);
      this.memory.set(key, String(value));
      return 'OK';
    }
  }

  async del(key) {
    try {
      if (this.isUpstash && this.client) {
        await this.client.del(key);
      }
    } catch (e) {
      console.error(`[Redis] DEL error for ${key}:`, e.message);
    }
    this.memory.delete(key);
    return 1;
  }

  async expire(key, seconds) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.expire(key, seconds);
      }
    } catch (e) {
      console.error(`[Redis] EXPIRE error for ${key}:`, e.message);
    }
    return 1;
  }

  async incr(key) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.incr(key);
      }
    } catch (e) {
      console.error(`[Redis] INCR error for ${key}:`, e.message);
    }
    const current = parseInt(this.memory.get(key) || '0', 10);
    const next = current + 1;
    this.memory.set(key, String(next));
    return next;
  }

  async lpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.lpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] LPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.unshift(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async rpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.rpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] RPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.push(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async lrange(key, start, stop) {
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.lrange(key, start, stop);
        if (Array.isArray(res)) return res.map(String);
      }
    } catch (e) {
      console.error(`[Redis] LRANGE error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    return list.slice(s, e + 1);
  }

  async ltrim(key, start, stop) {
    try {
      if (this.isUpstash && this.client) {
        return await this.client.ltrim(key, start, stop);
      }
    } catch (e) {
      console.error(`[Redis] LTRIM error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    const trimmed = list.slice(s, e + 1);
    this.memory.set(key, JSON.stringify(trimmed));
    return 'OK';
  }

  getMemoryList(key) {
    try {
      const raw = this.memory.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {}
    return [];
  }
}

const redis = new UpstashStore();

// ---------------------------------------------------------------------------
// 2. Timing-Safe Auth
// ---------------------------------------------------------------------------
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// 3. 30-Second In-Memory Settings Cache & Clean Defaults
// ---------------------------------------------------------------------------
let cachedSettings = null;
let lastSettingsFetch = 0;
const SETTINGS_CACHE_TTL = 30 * 1000;

const DEFAULT_PROFILE = {
  ownerName: 'JTech',
  ownerFirstName: '',
  ownerAbout: 'Leading tech brand and software solutions in Freetown, Sierra Leone. Dedicated to building innovative software, web, and mobile solutions.',
  ownerLanguages: 'English, Krio',
  writingStyle: 'Short, warm, natural, respectful, and direct. Sounds like a real person texting.',
  name: 'JTech',
  city: 'Freetown, Sierra Leone',
  timeZone: 'Africa/Freetown',
  job: 'Tech Company & Software Solutions',
  languages: 'English, Krio',
  facts: 'Technology provider based in Freetown, Sierra Leone. Builds software, web, and AI solutions.',
  sampleMessage1: 'Hello! Thanks for reaching out. How can I help you today?',
  sampleMessage2: 'Got it, I will check on this and get back to you shortly.',
  sampleMessage3: 'Have a great day! Let me know if you need anything else.'
};

const DEFAULT_BASE_RULES = 
`You are the JTech Assistant, an AI assistant for JTech.

CORE INSTRUCTIONS:
1. GREETING & IDENTITY: Introduce yourself as the JTech Assistant only in the very first message to a new contact or when explicitly asked who you are. Never repeat the introduction in the middle of an ongoing conversation.
2. HUMAN-LIKE TEXTING: Sound like a real person texting on WhatsApp: short, warm, and natural. Match the sender's language, dialect (English or Krio), and message length. Do not repeat the same opening, closing, or emoji pattern twice in a row. Absolutely no robotic phrases like "How may I assist you today?".
3. HONESTY ABOUT AI: If the sender asks whether you are a bot, answer honestly that you are the JTech Assistant, an AI assistant for JTech.
4. UNCERTAINTY: If you are unsure about anything, say so briefly or ask one short clarifying question. Never invent facts about JTech, prices, appointments, or commitments.
5. SENSITIVE DEFERRALS: For all money requests, passwords, appointments, meetings, and formal promises, politely say that the owner will respond personally. Never make financial, scheduling, or credential promises yourself.
6. BREVITY & FORMATTING: Keep replies concise (usually 1-3 sentences). Use WhatsApp formatting only (*bold*, _italic_). At most one emoji per message. Never use markdown headers or bullet stars without formatting.
7. PRIVACY: Memory and conversations are strictly private to each contact. Never disclose one contact's information, name, or messages to another.`;

async function getSettings(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSettings && (now - lastSettingsFetch < SETTINGS_CACHE_TTL)) {
    return cachedSettings;
  }

  try {
    const [rawProfile, rawRules, provider, geminiModel, groqModel, minDelay, maxDelay, isPaused, contactRules] = await Promise.all([
      redis.get('config:owner_profile'),
      redis.get('config:base_rules'),
      redis.get('config:ai_provider'),
      redis.get('config:gemini_model'),
      redis.get('config:groq_model'),
      redis.get('config:min_delay'),
      redis.get('config:max_delay'),
      redis.get('config:is_paused'),
      redis.get('config:contact_rules')
    ]);

    let profile = DEFAULT_PROFILE;
    if (rawProfile) {
      try { profile = { ...DEFAULT_PROFILE, ...JSON.parse(rawProfile) }; } catch (_) {}
    }

    let rules = contactRules ? JSON.parse(contactRules) : { mode: 'all', allowlist: [], blocklist: [] };

    cachedSettings = {
      profile,
      baseRules: rawRules || DEFAULT_BASE_RULES,
      provider: provider || 'gemini',
      geminiModel: geminiModel || 'gemini-2.5-flash',
      groqModel: groqModel || 'llama-3.3-70b-versatile',
      minDelay: parseInt(minDelay || '300', 10),
      maxDelay: parseInt(maxDelay || '1200', 10),
      isPaused: isPaused === 'true',
      contactRules: rules
    };
    lastSettingsFetch = now;
    return cachedSettings;
  } catch (err) {
    console.error('[Settings] Cache refresh error:', err.message);
    return cachedSettings || {
      profile: DEFAULT_PROFILE,
      baseRules: DEFAULT_BASE_RULES,
      provider: 'gemini',
      geminiModel: 'gemini-2.5-flash',
      groqModel: 'llama-3.3-70b-versatile',
      minDelay: 300,
      maxDelay: 1200,
      isPaused: false,
      contactRules: { mode: 'all', allowlist: [], blocklist: [] }
    };
  }
}

function invalidateSettingsCache() {
  cachedSettings = null;
  lastSettingsFetch = 0;
}

// ---------------------------------------------------------------------------
// 4. Baileys Redis Auth Adapter (wa:* keys)
// ---------------------------------------------------------------------------
async function useUpstashAuthState() {
  let creds;
  try {
    const rawCreds = await redis.get('wa:creds');
    if (rawCreds) {
      creds = JSON.parse(rawCreds, BufferJSON.reviver);
    }
  } catch (err) {
    console.warn('[Auth] Failed to parse wa:creds, initializing fresh creds:', err.message);
  }

  if (!creds) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              try {
                const keyName = `wa:keys:${type}:${id}`;
                const raw = await redis.get(keyName);
                if (raw) {
                  data[id] = JSON.parse(raw, BufferJSON.reviver);
                }
              } catch (e) {
                console.error(`[Auth] Error fetching key ${type}:${id}:`, e.message);
              }
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyName = `wa:keys:${category}:${id}`;
              if (value) {
                const str = JSON.stringify(value, BufferJSON.replacer);
                tasks.push(redis.set(keyName, str));
              } else {
                tasks.push(redis.del(keyName));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      try {
        const serialized = JSON.stringify(creds, BufferJSON.replacer);
        await redis.set('wa:creds', serialized);
      } catch (err) {
        console.error('[Auth] Failed to save wa:creds:', err.message);
      }
    }
  };
}

async function clearWhatsAppAuth() {
  try {
    await redis.del('wa:creds');
    console.log('[Auth] Cleared wa:creds from Redis');
  } catch (e) {
    console.error('[Auth] Error clearing wa:creds:', e.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Intelligent Prompt Builder & Africa/Freetown Clock
// ---------------------------------------------------------------------------
function getFreetownTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Freetown',
      dateStyle: 'full',
      timeStyle: 'medium'
    }).format(new Date());
  } catch (_) {
    return new Date().toUTCString();
  }
}

function formatLastSeen(lastSeenTimestamp) {
  if (!lastSeenTimestamp) return 'First time talking to this contact';
  const diffMs = Date.now() - lastSeenTimestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 5) return 'Active conversation (just spoke a moment ago)';
  if (diffMins < 60) return `Last spoke ${diffMins} minutes ago`;
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return `Last spoke ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 1) return 'Last spoke yesterday';
  return `Last spoke ${diffDays} days ago`;
}

function buildPrompt({
  baseRules,
  profile,
  contactFacts,
  chatSummary,
  senderJid,
  contactName,
  contactProfile,
  lastSpokeText,
  isFirstMessage
}) {
  const timeNow = getFreetownTime();
  
  let factsSection = 'None recorded yet.';
  if (Array.isArray(contactFacts) && contactFacts.length > 0) {
    factsSection = contactFacts.map(f => `- ${f}`).join('\n');
  }

  let summarySection = chatSummary ? chatSummary : 'First conversation or no older summary yet.';

  const ownerName = profile.ownerName || profile.name || 'JTech';
  const ownerAbout = profile.ownerAbout || profile.facts || 'Leading tech brand and software solutions in Freetown, Sierra Leone';
  const ownerLanguages = profile.ownerLanguages || profile.languages || 'English, Krio';
  const writingStyle = profile.writingStyle || 'Short, warm, natural, respectful, and direct. Sounds like a real person texting.';

  const contactLang = contactProfile?.preferredLanguage || 'English';
  const contactMsgLen = contactProfile?.typicalMessageLength || 'short';

  return `
${baseRules}

=== JTECH ASSISTANT & OWNER PROFILE ===
- Assistant Name: JTech Assistant (AI assistant for JTech)
- Owner Name: ${ownerName} ${profile.ownerFirstName ? `(First name: ${profile.ownerFirstName})` : ''}
- About Owner & JTech: ${ownerAbout}
- Location: ${profile.city || 'Freetown, Sierra Leone'} (Time zone: ${profile.timeZone || 'Africa/Freetown'})
- Current Date & Time in Freetown: ${timeNow}
- Languages spoken: ${ownerLanguages}
- Writing style to copy: ${writingStyle}

=== SAMPLES OF OWNER'S VOICE & TONE ===
Sample 1: "${profile.sampleMessage1 || 'Hello! Thanks for reaching out. How can I help you today?'}"
Sample 2: "${profile.sampleMessage2 || 'Got it, I will check on this and get back to you shortly.'}"
Sample 3: "${profile.sampleMessage3 || 'Have a great day! Let me know if you need anything else.'}"

=== THIS CONTACT & CONVERSATION CONTEXT ===
- Identifier: ${senderJid}
- Contact Name / Phone: ${contactName || 'Contact'}
- Conversation Timing: ${lastSpokeText || 'First conversation'}
- Introduction Rule: ${isFirstMessage ? 'FIRST EVER MESSAGE from this contact: Introduce yourself as the JTech Assistant.' : 'ONGOING/RETURNING CONTACT: Do NOT re-introduce yourself. Greet naturally as an existing conversation.'}
- Preferred Language: ${contactLang}
- Typical Message Length: ${contactMsgLen}
- Known Facts About This Contact:
${factsSection}

=== RECAP OF OLDER CHAT (ROLLING SUMMARY) ===
${summarySection}

CRITICAL RULES:
- Memory is strictly private to this contact. Never mention other contacts.
- Sound like a real person texting on WhatsApp: short, warm, natural.
- Use WhatsApp formatting (*bold*, _italic_) only, at most one emoji.
- Politely defer money requests, passwords, appointments, and promises to the owner personally.
`.trim();
}

// ---------------------------------------------------------------------------
// 6. Multi-Turn Conversation History (Alternating Turns for Gemini & Groq)
// ---------------------------------------------------------------------------
function buildAlternatingTurns(messages, latestUserText) {
  const mapped = [];
  for (const m of (messages || [])) {
    if (!m || !m.text || !m.text.trim()) continue;
    const isAssistant = Boolean(m.fromMe || m.role === 'assistant');
    mapped.push({
      role: isAssistant ? 'assistant' : 'user',
      text: m.text.trim()
    });
  }

  // Ensure the latest user message is the trailing item
  if (latestUserText && latestUserText.trim()) {
    const last = mapped[mapped.length - 1];
    if (!last || last.role !== 'user' || last.text !== latestUserText.trim()) {
      mapped.push({ role: 'user', text: latestUserText.trim() });
    }
  }

  // Take the last 12 messages maximum for context
  const sliced = mapped.slice(-12);

  // Merge consecutive same-role messages
  const merged = [];
  for (const msg of sliced) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].text += '\n' + msg.text;
    } else {
      merged.push({ role: msg.role, text: msg.text });
    }
  }

  // Must start with a user turn
  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift();
  }

  // Must end with a user turn (latest user message)
  if (merged.length === 0 || merged[merged.length - 1].role !== 'user') {
    merged.push({ role: 'user', text: latestUserText.trim() || 'Hello' });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// 7. Memory: 30-Day TTL, Per-Contact Profile, Rolling Summary & Facts
// ---------------------------------------------------------------------------
async function getChatMemory(jid) {
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

function isPersonalMessage(text) {
  if (!text) return false;
  const personalWords = /\b(my name|i live|i work|my birthday|my phone|my email|i am|i'm|i work at|my job|my age|my address|i study|my school|my college|my university|my wife|my husband|my daughter|my son|my brother|my sister)\b/i;
  const phonePattern = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}\b/;
  const datePattern = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
  return personalWords.test(text) || phonePattern.test(text) || datePattern.test(text);
}

function detectContactLanguage(text, existingLang = 'English') {
  const lower = (text || '').toLowerCase();
  const isKrio = /\b(kusheh|wetin|dey|una|leki|aw de go|di|ba|pikin|sef|krio|salone|na|dem|wetin dey)\b/i.test(lower);
  return isKrio ? 'Krio' : existingLang;
}

async function recordMessage(jid, role, text, fromMe = false, senderName = '') {
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

async function triggerRollingSummary(jid) {
  try {
    const [rawMessages, existingSummary] = await Promise.all([
      redis.lrange(`chat:${jid}:messages`, -20, -1),
      redis.get(`sum:${jid}`)
    ]);

    if (!rawMessages || rawMessages.length < 5) return;

    const chatLines = rawMessages.map(m => {
      try {
        const parsed = JSON.parse(m);
        return `${parsed.role === 'assistant' ? 'Assistant' : 'Contact'}: ${parsed.text}`;
      } catch (_) {
        return m;
      }
    }).join('\n');

    const prompt = `You are a conversation summarizer for JTech Assistant.
Task: Merge the previous summary with the newest conversation messages into one updated, cohesive rolling summary (max 600 characters).
Never overwrite the old summary with only the new part; combine them seamlessly.

PREVIOUS SUMMARY: "${existingSummary || 'None'}"
NEWEST CHAT MESSAGES:
${chatLines}

CRITICAL INSTRUCTIONS:
1. Output MUST be under 600 characters.
2. Cover: topics discussed, any promises made or deferred, open/pending questions, and the person's mood, tone, and preferences.
3. Be concise, factual, and cohesive.`;

    const res = await callGeminiWithTimeout(prompt, 'Summarize concisely under 600 characters. Output summary text only.', 'gemini-2.5-flash', 12000);
    if (res && res.text) {
      const trimmed = res.text.slice(0, 600);
      await redis.set(`sum:${jid}`, trimmed, { ex: CONTACT_TTL_SECONDS });
      console.log(`[Summary] Updated sum:${jid} (${trimmed.length} chars)`);
    }

    // Also extract facts during the summary step
    await extractContactFacts(jid, chatLines);
  } catch (err) {
    console.warn(`[Summary] Rolling summary failed for ${jid}:`, err.message);
  }
}

async function extractContactFacts(jid, textContent) {
  try {
    const rawFacts = await redis.get(`contact:${jid}:facts`);
    let facts = [];
    if (rawFacts) {
      try { facts = JSON.parse(rawFacts); } catch (_) {}
    }

    const prompt = `Extract permanent, useful facts about this contact from the conversation snippet:
Existing facts:
${facts.map(f => `- ${f}`).join('\n')}

New text:
"${textContent.slice(0, 800)}"

Instructions:
1. Extract facts like: name, location, occupation, birthday/age, contact details, key preferences.
2. Deduplicate with existing facts.
3. Return ONLY a valid JSON array of strings (e.g. ["Lives in Aberdeen", "Prefers WhatsApp for quotes"]).
4. Keep at most 10 facts total. If more than 10, drop the oldest/least relevant.`;

    const res = await callGeminiWithTimeout(prompt, 'Output JSON array only.', 'gemini-2.5-flash', 8000);
    if (res && res.text) {
      const match = res.text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          // Deduplicate and keep up to 10
          const set = new Set();
          for (const item of parsed) {
            const clean = String(item).trim();
            if (clean && clean.length < 120) set.add(clean);
          }
          const finalFacts = Array.from(set).slice(-10);
          await redis.set(`contact:${jid}:facts`, JSON.stringify(finalFacts), { ex: CONTACT_TTL_SECONDS });
          console.log(`[Facts] Saved ${finalFacts.length} facts for ${jid}`);
        }
      }
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 8. AI Providers: Gemini & Groq Multi-Turn with 12s Timeout & Fallback
// ---------------------------------------------------------------------------
let consecutiveFailures = 0;
let autoPauseUntil = 0;

async function checkAutoPause() {
  const until = await redis.get('autopause:until');
  if (until) {
    autoPauseUntil = parseInt(until, 10) || 0;
  }
  return Date.now() < autoPauseUntil;
}

async function recordAiFailure(provider, errorMsg) {
  try {
    const entry = JSON.stringify({
      provider,
      message: String(errorMsg).slice(0, 250),
      timestamp: Date.now()
    });
    await redis.lpush('stats:ai_errors', entry);
    await redis.ltrim('stats:ai_errors', 0, 4);
  } catch (_) {}
}

async function handleBothProvidersFailed(summary) {
  consecutiveFailures += 1;
  console.warn(`[Auto-Pause] Consecutive failure count: ${consecutiveFailures}/3`);
  if (consecutiveFailures >= 3) {
    autoPauseUntil = Date.now() + 10 * 60 * 1000;
    await redis.set('autopause:until', String(autoPauseUntil));
    await recordAiFailure('System (Auto-Pause)', `Paused replies for 10 min after 3 dual-failures: ${summary}`);
    console.error(`[Auto-Pause] Triggered! Replies paused until ${new Date(autoPauseUntil).toLocaleTimeString()}`);
  }
}

async function handleAiSuccess(provider) {
  consecutiveFailures = 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await Promise.all([
      redis.incr(`stats:replies:${today}`),
      redis.incr(`stats:provider:${provider.toLowerCase()}`)
    ]);
  } catch (_) {}
}

let geminiClient = null;
async function callGeminiWithTimeout(turnsOrText, systemInstruction, modelName = 'gemini-2.5-flash', timeoutMs = 12000) {
  const apiKey = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }

  // Format turns for Gemini: array of { role: 'user' | 'model', parts: [{ text }] }
  const turns = Array.isArray(turnsOrText)
    ? turnsOrText
    : [{ role: 'user', text: String(turnsOrText) }];

  const geminiContents = turns.map(t => ({
    role: t.role === 'user' ? 'user' : 'model',
    parts: [{ text: t.text }]
  }));

  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Gemini timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  const apiPromise = geminiClient.models.generateContent({
    model: modelName,
    contents: geminiContents,
    config: {
      systemInstruction,
      temperature: 0.65,
      maxOutputTokens: 350
    }
  });

  const response = await Promise.race([apiPromise, timeoutPromise]);
  const text = response?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Empty response from Gemini');
  }
  return { text: text.trim(), provider: 'gemini' };
}

async function callGroqWithTimeout(turnsOrText, systemInstruction, modelName = 'llama-3.3-70b-versatile', timeoutMs = 12000) {
  const apiKey = process.env.GROQ_API_KEY || GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  // Format turns for Groq: array of { role: 'system' | 'user' | 'assistant', content }
  const turns = Array.isArray(turnsOrText)
    ? turnsOrText
    : [{ role: 'user', text: String(turnsOrText) }];

  const groqMessages = [
    { role: 'system', content: systemInstruction },
    ...turns.map(t => ({
      role: t.role === 'user' ? 'user' : 'assistant',
      content: t.text
    }))
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: groqMessages,
        max_tokens: 350,
        temperature: 0.65
      })
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Groq HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No reply choices from Groq');
    return { text: reply.trim(), provider: 'groq' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Groq timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function generateAiReply(turns, promptBuilderArgs) {
  const settings = await getSettings();

  if (settings.isPaused) {
    return { text: null, paused: true, reason: 'Manual pause active' };
  }

  if (await checkAutoPause()) {
    const remainingSecs = Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000));
    return { text: null, paused: true, remainingSecs, reason: 'Auto-pause active' };
  }

  const systemInstruction = buildPrompt({
    baseRules: settings.baseRules,
    profile: settings.profile,
    contactFacts: promptBuilderArgs.contactFacts,
    chatSummary: promptBuilderArgs.chatSummary,
    senderJid: promptBuilderArgs.senderJid,
    contactName: promptBuilderArgs.contactName,
    contactProfile: promptBuilderArgs.contactProfile,
    lastSpokeText: promptBuilderArgs.lastSpokeText,
    isFirstMessage: promptBuilderArgs.isFirstMessage
  });

  const primary = (settings.provider || 'gemini').toLowerCase();
  const fallback = primary === 'gemini' ? 'groq' : 'gemini';

  try {
    let result;
    if (primary === 'gemini') {
      result = await callGeminiWithTimeout(turns, systemInstruction, settings.geminiModel, 12000);
    } else {
      result = await callGroqWithTimeout(turns, systemInstruction, settings.groqModel, 12000);
    }
    await handleAiSuccess(primary);
    return { text: result.text, provider: primary, fallbackUsed: false };
  } catch (primaryErr) {
    console.warn(`[AI] Primary ${primary} failed:`, primaryErr.message);
    await recordAiFailure(primary, primaryErr.message);

    try {
      let fallbackResult;
      if (fallback === 'gemini') {
        fallbackResult = await callGeminiWithTimeout(turns, systemInstruction, settings.geminiModel, 12000);
      } else {
        fallbackResult = await callGroqWithTimeout(turns, systemInstruction, settings.groqModel, 12000);
      }
      await handleAiSuccess(fallback);
      return { text: fallbackResult.text, provider: fallback, fallbackUsed: true };
    } catch (fallbackErr) {
      console.error(`[AI] Fallback ${fallback} failed:`, fallbackErr.message);
      await recordAiFailure(fallback, fallbackErr.message);
      await handleBothProvidersFailed(`${primary}: ${primaryErr.message} | ${fallback}: ${fallbackErr.message}`);
      throw new Error(`Both AI providers failed. ${primary}: ${primaryErr.message}. ${fallback}: ${fallbackErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Baileys WhatsApp Connection
// ---------------------------------------------------------------------------
let sock = null;
let connectionStatus = 'disconnected';
let currentPairingCode = null;
let activePhone = '';

const botSentMessageIds = new Set();
const logger = pino({ level: 'silent' });

function cleanDigits(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

function matchesContactRule(jid, list, knownPhone = '') {
  if (!Array.isArray(list) || list.length === 0) return false;
  const cleanJid = (jid || '').toLowerCase().trim();
  const phoneDigits = cleanDigits(knownPhone || jid.split('@')[0]);

  for (const entry of list) {
    if (!entry) continue;
    const cleanEntry = entry.toLowerCase().trim();
    const entryDigits = cleanDigits(cleanEntry);

    if (cleanJid === cleanEntry) return true;
    if (cleanJid.includes(cleanEntry) || cleanEntry.includes(cleanJid)) return true;

    if (phoneDigits && entryDigits) {
      if (phoneDigits === entryDigits || phoneDigits.endsWith(entryDigits) || entryDigits.endsWith(phoneDigits)) {
        return true;
      }
    }
  }
  return false;
}

async function startWhatsApp(pairingPhone = '') {
  try {
    const { state, saveCreds } = await useUpstashAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['JTech Assistant', 'Chrome', '124.0.0'],
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'connecting') {
        connectionStatus = 'connecting';
        console.log('[WhatsApp] Connecting...');
      } else if (connection === 'open') {
        connectionStatus = 'open';
        currentPairingCode = null;
        console.log('[WhatsApp] Connection opened successfully! JTech Assistant is active.');
      } else if (connection === 'close') {
        connectionStatus = 'disconnected';
        currentPairingCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[WhatsApp] Connection closed (status: ${statusCode}). Logged out: ${loggedOut}`);

        if (loggedOut) {
          console.warn('[WhatsApp] Session logged out. Clearing wa:* keys from Redis...');
          await clearWhatsAppAuth();
          if (activePhone) {
            setTimeout(() => startWhatsApp(activePhone), 4000);
          }
        } else {
          setTimeout(() => startWhatsApp(activePhone), 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        try {
          await handleIncomingMessage(m);
        } catch (err) {
          console.error('[WhatsApp] Safe-caught message error:', err.message);
        }
      }
    });

    const phoneToPair = pairingPhone || activePhone;
    if (!sock.authState.creds.registered && phoneToPair) {
      setTimeout(async () => {
        try {
          const digits = cleanDigits(phoneToPair);
          if (digits && sock && !sock.authState.creds.registered) {
            console.log(`[WhatsApp] Requesting pairing code for: ${digits}`);
            const code = await sock.requestPairingCode(digits);
            currentPairingCode = code;
            activePhone = digits;
            console.log(`[WhatsApp] Pairing code generated: ${code}`);
          }
        } catch (err) {
          console.error('[WhatsApp] Pairing code generation error:', err.message);
          currentPairingCode = null;
        }
      }, 3500);
    }
  } catch (err) {
    console.error('[WhatsApp] Critical startup error:', err.message);
    connectionStatus = 'disconnected';
  }
}

// ---------------------------------------------------------------------------
// 10. Core Incoming Message Pipeline
// ---------------------------------------------------------------------------
async function handleIncomingMessage(m) {
  if (!m || !m.message) return;

  const senderJid = m.key.remoteJid || '';
  if (!senderJid) return;

  if (senderJid.endsWith('@g.us')) return;
  if (senderJid.includes('@broadcast') || senderJid === 'status@broadcast') return;
  if (senderJid.endsWith('@newsletter')) return;

  const msgId = m.key.id;

  // Owner human reply detection
  if (m.key.fromMe) {
    if (botSentMessageIds.has(msgId)) return;

    const silenceUntil = Date.now() + 10 * 60 * 1000;
    await redis.set(`handoff:${senderJid}`, String(silenceUntil), { ex: 600 });
    console.log(`[Human Reply] Owner replied directly to ${senderJid}. Silencing bot for 10 minutes.`);
    
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Owner sent media]';
    await recordMessage(senderJid, 'assistant', text, true, 'Owner (You)');
    return;
  }

  // Check Handoff Status
  const handoffVal = await redis.get(`handoff:${senderJid}`);
  if (handoffVal) {
    const until = parseInt(handoffVal, 10);
    if (!isNaN(until) && Date.now() < until) {
      const remainingMins = Math.ceil((until - Date.now()) / 60000);
      console.log(`[Handoff] Active silence for ${senderJid} (${remainingMins}m remaining).`);
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    } else if (isNaN(until)) {
      console.log(`[Handoff] Manual takeover active for ${senderJid}.`);
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    }
  }

  // Contact Rules Check
  const settings = await getSettings();
  const rules = settings.contactRules || { mode: 'all', allowlist: [], blocklist: [] };
  const phone = jidToPhone(senderJid);

  if (rules.mode === 'allowlist') {
    if (!matchesContactRule(senderJid, rules.allowlist, phone)) return;
  } else if (rules.mode === 'blocklist') {
    if (matchesContactRule(senderJid, rules.blocklist, phone)) return;
  }

  const pushName = m.pushName || '';
  const msgContent = m.message;

  let userText = '';
  let isMedia = false;

  if (msgContent.conversation) {
    userText = msgContent.conversation;
  } else if (msgContent.extendedTextMessage?.text) {
    userText = msgContent.extendedTextMessage.text;
  } else if (msgContent.imageMessage) {
    isMedia = true;
    userText = msgContent.imageMessage.caption || '';
  } else if (msgContent.audioMessage) {
    isMedia = true;
  } else if (msgContent.videoMessage) {
    isMedia = true;
    userText = msgContent.videoMessage.caption || '';
  } else if (msgContent.documentMessage) {
    isMedia = true;
  } else if (msgContent.stickerMessage) {
    return;
  }

  if (isMedia && !userText.trim()) {
    const politeReply = `Hello! I am the *JTech Assistant*. I cannot process voice notes or photos. Please send your message as text. 🙏`;
    await recordMessage(senderJid, 'user', '[Voice note or Image received]', false, pushName);
    
    await sock.sendPresenceUpdate('composing', senderJid);
    await new Promise(r => setTimeout(r, 600));
    await sock.sendPresenceUpdate('paused', senderJid);

    const sent = await sock.sendMessage(senderJid, { text: politeReply }, { quoted: m });
    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    await recordMessage(senderJid, 'assistant', politeReply, true, 'JTech Assistant');
    return;
  }

  if (!userText || !userText.trim()) return;
  const cleanText = userText.trim();

  // Parallel fetch: get existing memory & context
  const memory = await getChatMemory(senderJid);

  const lastSpokeText = formatLastSeen(memory.profile?.lastSeen);
  const isFirstMessage = !memory.profile?.firstSeen || memory.messages.length === 0;

  // Record incoming user message
  await recordMessage(senderJid, 'user', cleanText, false, pushName);

  // Build multi-turn context (last 12 messages with alternating turns)
  const fullConversation = [...memory.messages, { role: 'user', text: cleanText, fromMe: false }];
  const turns = buildAlternatingTurns(fullConversation, cleanText);

  await sock.sendPresenceUpdate('composing', senderJid);

  try {
    const aiResult = await generateAiReply(turns, {
      contactFacts: memory.facts,
      chatSummary: memory.summary,
      senderJid,
      contactName: pushName || phone,
      contactProfile: memory.profile,
      lastSpokeText,
      isFirstMessage
    });

    if (aiResult.paused) {
      await sock.sendPresenceUpdate('paused', senderJid);
      return;
    }

    if (aiResult.text) {
      const minD = Math.max(100, settings.minDelay);
      const maxD = Math.max(minD, settings.maxDelay);
      const delay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
      await new Promise(r => setTimeout(r, delay));

      await sock.sendPresenceUpdate('paused', senderJid);

      const sent = await sock.sendMessage(senderJid, { text: aiResult.text }, { quoted: m });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 2000) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }

      await recordMessage(senderJid, 'assistant', aiResult.text, true, `JTech Assistant (${aiResult.provider})`);
      console.log(`[Reply] Sent AI reply to ${senderJid} via ${aiResult.provider} (delay ${delay}ms)`);
    }
  } catch (err) {
    await sock.sendPresenceUpdate('paused', senderJid);
    console.error(`[Reply] Error answering ${senderJid}:`, err.message);
  }
}

function jidToPhone(jid) {
  if (!jid) return '';
  const [user] = jid.split('@');
  return /^\d+$/.test(user) ? user : '';
}

// ---------------------------------------------------------------------------
// 11. Express Server, CORS (with ALLOWED_ORIGIN & Vary: Origin) & Token Auth
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Enable Cross-Origin Resource Sharing (CORS) with ALLOWED_ORIGIN and Vary: Origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pass');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Public health check route for uptime pingers
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'JTech Assistant',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    whatsapp: connectionStatus
  });
});

// Authentication middleware accepting Authorization: Bearer <token> or x-pass
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const valid = await redis.get('session:' + token);
      if (valid) {
        return next();
      }
    }
  }

  // Fallback for x-pass header only (NO req.query.pass)
  const pass = req.headers['x-pass'];
  if (DASHBOARD_PASSWORD && pass && timingSafeEqualStr(String(pass), String(DASHBOARD_PASSWORD))) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
}

// POST /api/login { password } returns { token }
app.post('/api/login', async (req, res) => {
  try {
    if (!DASHBOARD_PASSWORD) {
      console.warn('[Auth] Login attempt rejected: DASHBOARD_PASSWORD is not set in server environment.');
      return res.status(500).json({ error: 'Server authentication unconfigured: DASHBOARD_PASSWORD missing' });
    }

    const { password } = req.body;
    if (!password || !timingSafeEqualStr(String(password), String(DASHBOARD_PASSWORD))) {
      return res.status(401).json({ error: 'Incorrect dashboard password' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    await redis.set('session:' + token, '1', { ex: 86400 * 14 }); // 14 days TTL
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/state
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const isPaused = await checkAutoPause();
    const remainingPauseSecs = isPaused ? Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000)) : 0;
    const settings = await getSettings();
    const today = new Date().toISOString().slice(0, 10);
    const [repliesToday, geminiCount, groqCount, rawErrors] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4)
    ]);

    let connPill = 'Offline';
    if (connectionStatus === 'open') {
      connPill = 'Connected';
    } else if (connectionStatus === 'connecting' || currentPairingCode) {
      connPill = 'Waiting';
    }

    const recentErrors = [];
    for (const item of (rawErrors || [])) {
      try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
    }

    res.json({
      connectionPill: connPill,
      status: connectionStatus,
      pairingCode: currentPairingCode,
      activePhone,
      isAutoPaused: isPaused,
      remainingPauseSecs,
      isManualPaused: settings.isPaused,
      consecutiveFailures,
      activeProvider: settings.provider,
      geminiModel: settings.geminiModel,
      groqModel: settings.groqModel,
      uptime: Math.floor(process.uptime()),
      freetownTime: getFreetownTime(),
      repliesToday: parseInt(repliesToday || '0', 10),
      providers: {
        gemini: parseInt(geminiCount || '0', 10),
        groq: parseInt(groqCount || '0', 10)
      },
      recentErrors,
      keys: {
        gemini: Boolean(process.env.GEMINI_API_KEY || GEMINI_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY || GROQ_API_KEY),
        redis: Boolean(redis.isUpstash)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/link { phone }
app.post('/api/link', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    const digits = cleanDigits(phone);
    if (!digits) {
      return res.status(400).json({ error: 'Please enter a valid phone number (digits only, e.g. 23276123456)' });
    }

    activePhone = digits;
    if (sock && sock.authState && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(digits);
        currentPairingCode = code;
        return res.json({ success: true, pairingCode: code, phone: digits });
      } catch (pairErr) {
        return res.status(500).json({ error: `Pairing error: ${pairErr.message}` });
      }
    } else {
      startWhatsApp(digits);
      return res.json({ success: true, message: 'Initiating pairing... check pairing code in 3 seconds', phone: digits });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfg and POST /api/cfg
app.get('/api/cfg', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings(true);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cfg', requireAuth, async (req, res) => {
  try {
    const { profile, baseRules, provider, geminiModel, groqModel, minDelay, maxDelay, isPaused, contactRules } = req.body;

    if (profile && typeof profile === 'object') {
      await redis.set('config:owner_profile', JSON.stringify(profile));
    }
    if (typeof baseRules === 'string') {
      await redis.set('config:base_rules', baseRules.trim());
    }
    if (provider && (provider === 'gemini' || provider === 'groq')) {
      await redis.set('config:ai_provider', provider);
    }
    if (geminiModel) await redis.set('config:gemini_model', String(geminiModel).trim());
    if (groqModel) await redis.set('config:groq_model', String(groqModel).trim());
    if (minDelay !== undefined) await redis.set('config:min_delay', String(minDelay));
    if (maxDelay !== undefined) await redis.set('config:max_delay', String(maxDelay));
    if (isPaused !== undefined) await redis.set('config:is_paused', isPaused ? 'true' : 'false');

    if (contactRules && typeof contactRules === 'object') {
      const mode = ['all', 'allowlist', 'blocklist'].includes(contactRules.mode) ? contactRules.mode : 'all';
      const cleanList = arr => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean) : [];
      await redis.set('config:contact_rules', JSON.stringify({
        mode,
        allowlist: cleanList(contactRules.allowlist),
        blocklist: cleanList(contactRules.blocklist)
      }));
    }

    invalidateSettingsCache();
    res.json({ success: true, message: 'Configuration saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats
app.get('/api/chats', requireAuth, async (req, res) => {
  try {
    const recentRaw = await redis.get('chats:recent');
    let jids = [];
    if (recentRaw) {
      try { jids = JSON.parse(recentRaw); } catch (_) {}
    }

    const conversations = [];
    for (const jid of jids.slice(0, 30)) {
      try {
        const [metaRaw, handoffVal] = await Promise.all([
          redis.get(`chat:${jid}:meta`),
          redis.get(`handoff:${jid}`)
        ]);

        let isHandoff = false;
        if (handoffVal) {
          const until = parseInt(handoffVal, 10);
          isHandoff = isNaN(until) ? true : Date.now() < until;
        }

        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          meta.isHandoff = isHandoff;
          conversations.push(meta);
        } else {
          conversations.push({
            jid,
            name: jidToPhone(jid) || jid,
            lastMessage: '',
            timestamp: 0,
            isHandoff
          });
        }
      } catch (_) {}
    }

    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats/:jid
app.get('/api/chats/:jid', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    const memory = await getChatMemory(jid);
    const metaRaw = await redis.get(`chat:${jid}:meta`);
    let meta = null;
    if (metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch (_) {}
    }

    res.json({
      jid,
      meta,
      isHandoff: memory.isHandoff,
      summary: memory.summary,
      facts: memory.facts,
      profile: memory.profile,
      messages: memory.messages.slice(-12)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chats/:jid/takeover
app.post('/api/chats/:jid/takeover', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.set(`handoff:${jid}`, 'manual_takeover');
    res.json({ success: true, message: `Bot paused for ${jid}. Human takeover active.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chats/:jid/resume
app.post('/api/chats/:jid/resume', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.del(`handoff:${jid}`);
    res.json({ success: true, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [repliesToday, geminiCount, groqCount, rawErrors] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4)
    ]);

    const recentErrors = [];
    for (const item of (rawErrors || [])) {
      try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
    }

    res.json({
      repliesToday: parseInt(repliesToday || '0', 10),
      providers: {
        gemini: parseInt(geminiCount || '0', 10),
        groq: parseInt(groqCount || '0', 10)
      },
      uptime: Math.floor(process.uptime()),
      recentErrors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clear-memory
app.post('/api/clear-memory', requireAuth, async (req, res) => {
  try {
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
    res.json({ success: true, message: 'All contact chat memory and summaries cleared.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logout-wa
app.post('/api/logout-wa', requireAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    await clearWhatsAppAuth();
    connectionStatus = 'disconnected';
    currentPairingCode = null;
    res.json({ success: true, message: 'Logged out and wa:* keys cleared from Redis' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compatibility aliases
app.get('/api/settings', requireAuth, (req, res) => res.redirect('/api/cfg'));
app.post('/api/settings', requireAuth, (req, res) => res.redirect(307, '/api/cfg'));
app.get('/api/status', requireAuth, (req, res) => res.redirect('/api/state'));
app.get('/api/usage', requireAuth, (req, res) => res.redirect('/api/stats'));
app.post('/api/logout', requireAuth, (req, res) => res.redirect(307, '/api/logout-wa'));
app.post('/api/clear-all-memory', requireAuth, (req, res) => res.redirect(307, '/api/clear-memory'));

// Serve UI dashboard
app.get('/', (req, res) => {
  const uiPath = path.join(__dirname, 'ui.html');
  if (fs.existsSync(uiPath)) {
    res.sendFile(uiPath);
  } else {
    res.send('ui.html not found');
  }
});

app.get('/ui.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// Start Express and WhatsApp
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` JTech Assistant backend running on port ${PORT}`);
  console.log(` Dashboard URL: http://localhost:${PORT}`);
  console.log(` Health check URL: http://localhost:${PORT}/health`);
  console.log(` CORS Allowed Origin: ${ALLOWED_ORIGIN}`);
  console.log(`====================================================`);

  startWhatsApp().catch((err) => {
    console.error('[WhatsApp] Background start error:', err.message);
  });
});
