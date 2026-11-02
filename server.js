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
 * - Robust pairing flow: unexpired 60s pairing code, no auto-requests, no 401 loop
 * - Differentiated 401 & 408 handling: clears keys only on genuine logout, exponential backoff on timeouts
 * - Clear status model: server, whatsapp, pairing, lastError, services, events
 * - Self-ping keep-awake to RENDER_EXTERNAL_URL every 4 minutes
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
  BufferJSON,
  Browsers
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || '';
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

// Ring buffer for last 20 log events
const MAX_EVENTS = 20;
const eventLog = [];

function logEvent(level, message) {
  const item = { time: Date.now(), level, message };
  eventLog.push(item);
  if (eventLog.length > MAX_EVENTS) {
    eventLog.shift();
  }
  const prefix = level.toUpperCase().padEnd(5);
  console.log(`[${prefix}] ${message}`);
}

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
        logEvent('info', 'Connected to Upstash Redis REST (automaticDeserialization: false)');
      } catch (err) {
        logEvent('error', `Upstash init error, falling back to local memory store: ${err.message}`);
        this.client = null;
        this.isUpstash = false;
      }
    } else {
      logEvent('warn', 'No valid UPSTASH_REDIS_REST_URL / TOKEN. Running with in-memory store.');
      this.client = null;
    }
    this.memory = new Map();
  }

  async ping() {
    try {
      if (this.isUpstash && this.client) {
        await this.client.get('__ping__');
        return 'ok';
      }
      return this.isUpstash ? 'error' : 'ok';
    } catch (_) {
      return 'error';
    }
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
// 3. Settings Cache & Identity Defaults
// ---------------------------------------------------------------------------
let cachedSettings = null;
let lastSettingsFetch = 0;
const SETTINGS_CACHE_TTL = 30 * 1000;

const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const FALLBACK_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

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
      geminiModel: geminiModel || DEFAULT_GEMINI_MODEL,
      groqModel: groqModel || DEFAULT_GROQ_MODEL,
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
      geminiModel: DEFAULT_GEMINI_MODEL,
      groqModel: DEFAULT_GROQ_MODEL,
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
    logEvent('warn', `Failed to parse wa:creds, initializing fresh creds: ${err.message}`);
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
        logEvent('error', `Failed to save wa:creds: ${err.message}`);
      }
    }
  };
}

async function clearWhatsAppAuth() {
  try {
    await redis.del('wa:creds');
    logEvent('info', 'Cleared wa:creds from Redis');
  } catch (e) {
    logEvent('error', `Error clearing wa:creds: ${e.message}`);
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
// 6. Multi-Turn Conversation History
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

    const settings = await getSettings();
    const model = settings.geminiModel || DEFAULT_GEMINI_MODEL;
    const res = await callGeminiWithTimeout(prompt, 'Summarize concisely under 600 characters. Output summary text only.', model, 12000);
    if (res && res.text) {
      const trimmed = res.text.slice(0, 600);
      await redis.set(`sum:${jid}`, trimmed, { ex: CONTACT_TTL_SECONDS });
      logEvent('info', `Updated sum:${jid} (${trimmed.length} chars)`);
    }

    // Also extract facts during the summary step
    await extractContactFacts(jid, chatLines);
  } catch (err) {
    logEvent('warn', `Rolling summary failed for ${jid}: ${err.message}`);
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

    const settings = await getSettings();
    const model = settings.geminiModel || DEFAULT_GEMINI_MODEL;
    const res = await callGeminiWithTimeout(prompt, 'Output JSON array only.', model, 8000);
    if (res && res.text) {
      const match = res.text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const set = new Set();
          for (const item of parsed) {
            const clean = String(item).trim();
            if (clean && clean.length < 120) set.add(clean);
          }
          const finalFacts = Array.from(set).slice(-10);
          await redis.set(`contact:${jid}:facts`, JSON.stringify(finalFacts), { ex: CONTACT_TTL_SECONDS });
          logEvent('info', `Saved ${finalFacts.length} facts for ${jid}`);
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
let lastAiTest = null;

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
  logEvent('warn', `Consecutive AI failure count: ${consecutiveFailures}/3`);
  if (consecutiveFailures >= 3) {
    autoPauseUntil = Date.now() + 10 * 60 * 1000;
    await redis.set('autopause:until', String(autoPauseUntil));
    await recordAiFailure('System (Auto-Pause)', `Paused replies for 10 min after 3 dual-failures: ${summary}`);
    logEvent('error', `Auto-pause triggered! Replies paused until ${new Date(autoPauseUntil).toLocaleTimeString()}`);
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

let isFirstAiCall = true;

async function callProviderWithTimeoutRetry(provider, turns, systemInstruction, modelName, timeoutMs) {
  try {
    if (provider === 'gemini') {
      return await callGeminiWithTimeout(turns, systemInstruction, modelName, timeoutMs);
    } else {
      return await callGroqWithTimeout(turns, systemInstruction, modelName, timeoutMs);
    }
  } catch (err) {
    const isTimeout = /timeout|aborterror/i.test(err.message || '');
    if (isTimeout) {
      logEvent('warn', `${provider} timed out after ${timeoutMs}ms. Retrying once before fallback...`);
      if (provider === 'gemini') {
        return await callGeminiWithTimeout(turns, systemInstruction, modelName, timeoutMs);
      } else {
        return await callGroqWithTimeout(turns, systemInstruction, modelName, timeoutMs);
      }
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
  const primaryModel = primary === 'gemini' ? (settings.geminiModel || DEFAULT_GEMINI_MODEL) : (settings.groqModel || DEFAULT_GROQ_MODEL);
  const fallbackModel = fallback === 'gemini' ? (settings.geminiModel || DEFAULT_GEMINI_MODEL) : (settings.groqModel || DEFAULT_GROQ_MODEL);

  const callTimeout = isFirstAiCall ? 20000 : 12000;
  isFirstAiCall = false;

  try {
    const result = await callProviderWithTimeoutRetry(primary, turns, systemInstruction, primaryModel, callTimeout);
    await handleAiSuccess(primary);
    return { text: result.text, provider: primary, fallbackUsed: false };
  } catch (primaryErr) {
    logEvent('warn', `Primary ${primary} failed after retry/timeout: ${primaryErr.message}`);
    await recordAiFailure(primary, primaryErr.message);

    try {
      const fallbackResult = await callProviderWithTimeoutRetry(fallback, turns, systemInstruction, fallbackModel, 12000);
      await handleAiSuccess(fallback);
      return { text: fallbackResult.text, provider: fallback, fallbackUsed: true };
    } catch (fallbackErr) {
      logEvent('error', `Fallback ${fallback} failed: ${fallbackErr.message}`);
      await recordAiFailure(fallback, fallbackErr.message);
      await handleBothProvidersFailed(`${primary}: ${primaryErr.message} | ${fallback}: ${fallbackErr.message}`);
      throw new Error(`Both AI providers failed. ${primary}: ${primaryErr.message}. ${fallback}: ${fallbackErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Baileys WhatsApp Connection & Pairing Flow
// ---------------------------------------------------------------------------
let sock = null;
let whatsappState = 'not_linked'; // 'not_linked' | 'connecting' | 'code_ready' | 'connected' | 'reconnecting' | 'logged_out' | 'error'
let whatsappStateSince = Date.now();
let currentPairingCode = null;
let pairingExpiresAt = 0;
let activePhone = '';
let lastError = null; // { code, message, hint, at }

let reconnectAttempts = 0;
let reconnectTimer = null;
let isSocketOpenForPairing = false;
let pairingWaiters = [];
let isPairingInProgress = false;

function notifyPairingWaiters() {
  const waiters = pairingWaiters;
  pairingWaiters = [];
  for (const fn of waiters) {
    try { fn(); } catch (_) {}
  }
}

function waitForSocketOpenForPairing(timeoutMs = 30000) {
  if (isSocketOpenForPairing && sock && !sock.authState?.creds?.registered) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for WhatsApp socket to open for pairing'));
      }
    }, timeoutMs);

    pairingWaiters.push(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

const botSentMessageIds = new Set();
const logger = pino({ level: 'silent' });

function setWhatsappState(newState) {
  if (whatsappState !== newState) {
    whatsappState = newState;
    whatsappStateSince = Date.now();
    logEvent('info', `WhatsApp state changed: ${newState}`);
  }
}

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

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(60000, 5000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  setWhatsappState('reconnecting');
  logEvent('warn', `Recoverable disconnect. Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    startWhatsApp();
  }, delay);
}

async function startWhatsApp() {
  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const { state, saveCreds } = await useUpstashAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logEvent('info', `Fetched Baileys version: ${Array.isArray(version) ? version.join('.') : version} (isLatest: ${isLatest})`);

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logEvent('info', 'Received pairing challenge event (socket is open for pairing).');
        isSocketOpenForPairing = true;
        notifyPairingWaiters();
      }

      if (connection === 'connecting') {
        if (whatsappState !== 'reconnecting' && whatsappState !== 'code_ready') {
          setWhatsappState('connecting');
        }
        if (!sock?.authState?.creds?.registered) {
          isSocketOpenForPairing = true;
          notifyPairingWaiters();
        }
      } else if (connection === 'open') {
        setWhatsappState('connected');
        currentPairingCode = null;
        pairingExpiresAt = 0;
        lastError = null;
        reconnectAttempts = 0;
        isSocketOpenForPairing = false;
        logEvent('info', 'WhatsApp connection established successfully. JTech Assistant is online.');
      } else if (connection === 'close') {
        isSocketOpenForPairing = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isRegistered = Boolean(sock?.authState?.creds?.registered);

        logEvent('warn', `WhatsApp connection closed. Status code: ${statusCode}, registered: ${isRegistered}`);

        if (statusCode === DisconnectReason.loggedOut) { // 401
          if (isRegistered) {
            // Real logout from phone
            logEvent('warn', 'Session logged out from device. Wiping credentials.');
            await clearWhatsAppAuth();
            setWhatsappState('logged_out');
            lastError = {
              code: 401,
              message: 'WhatsApp session was unlinked from phone',
              hint: 'Go to the Link screen to pair your WhatsApp account again.',
              at: Date.now()
            };
            currentPairingCode = null;
            pairingExpiresAt = 0;
          } else {
            // 401 during pairing (never registered) MUST NOT wipe anything and MUST NOT retry!
            logEvent('error', 'WhatsApp rejected the pairing attempt (401). Stopping retry loop.');
            setWhatsappState('error');
            lastError = {
              code: 401,
              message: 'WhatsApp rejected the pairing attempt (401)',
              hint: 'Wait a few minutes, remove old linked devices in WhatsApp Settings > Linked devices, then try once.',
              at: Date.now()
            };
            currentPairingCode = null;
            pairingExpiresAt = 0;
          }
        } else if (statusCode === 408 || statusCode === DisconnectReason.timedOut || statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.restartRequired) {
          // Recoverable close: reconnect with exponential backoff if registered
          if (isRegistered) {
            scheduleReconnect();
          } else {
            if (currentPairingCode && pairingExpiresAt > Date.now()) {
              logEvent('info', 'Recoverable timeout while pairing code is pending. Waiting for user code entry.');
              setWhatsappState('code_ready');
            } else {
              setWhatsappState('not_linked');
            }
          }
        } else {
          // Other close reason
          if (isRegistered) {
            scheduleReconnect();
          } else {
            setWhatsappState('not_linked');
          }
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

  } catch (err) {
    isSocketOpenForPairing = false;
    logEvent('error', `Critical WhatsApp startup error: ${err.message}`);
    setWhatsappState('error');
    lastError = {
      code: 500,
      message: err.message,
      hint: 'Check server logs or restart WhatsApp from Settings.',
      at: Date.now()
    };
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
    logEvent('info', `Owner replied directly to ${senderJid}. Silencing bot for 10 minutes.`);
    
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
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    } else if (isNaN(until)) {
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
      logEvent('info', `Sent AI reply to ${senderJid} via ${aiResult.provider} (${delay}ms delay)`);
    }
  } catch (err) {
    await sock.sendPresenceUpdate('paused', senderJid);
    logEvent('error', `Error answering ${senderJid}: ${err.message}`);
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

// Public health check route for uptime pingers & self-ping keep-awake
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'JTech Assistant',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    whatsapp: whatsappState
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

  return res.status(401).json({
    error: 'Unauthorized: Invalid or expired token',
    code: 'UNAUTHORIZED',
    hint: 'Please sign in with your DASHBOARD_PASSWORD to continue.'
  });
}

// POST /api/login { password } returns { token }
app.post('/api/login', async (req, res) => {
  try {
    if (!DASHBOARD_PASSWORD) {
      logEvent('warn', 'Login attempt rejected: DASHBOARD_PASSWORD is not set in server environment.');
      return res.status(500).json({
        error: 'Server authentication unconfigured: DASHBOARD_PASSWORD missing',
        code: 'AUTH_UNCONFIGURED',
        hint: 'Configure the DASHBOARD_PASSWORD variable in your Render dashboard Environment settings.'
      });
    }

    const { password } = req.body;
    if (!password || !timingSafeEqualStr(String(password), String(DASHBOARD_PASSWORD))) {
      return res.status(401).json({
        error: 'Incorrect dashboard password',
        code: 'INVALID_CREDENTIALS',
        hint: 'Please re-enter your DASHBOARD_PASSWORD exactly as set in Render.'
      });
    }

    const token = crypto.randomBytes(24).toString('hex');
    await redis.set('session:' + token, '1', { ex: 86400 * 14 }); // 14 days TTL
    logEvent('info', 'Dashboard authenticated successfully via password.');
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'LOGIN_FAILED',
      hint: 'An unexpected error occurred during sign in. Check system logs.'
    });
  }
});

// GET /api/state
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const isPaused = await checkAutoPause();
    const remainingPauseSecs = isPaused ? Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000)) : 0;
    const settings = await getSettings();
    const today = new Date().toISOString().slice(0, 10);
    const [repliesToday, geminiCount, groqCount, rawErrors, upstashStatus] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4),
      redis.ping()
    ]);

    const pairingSecondsLeft = pairingExpiresAt > Date.now()
      ? Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000))
      : 0;

    // Clear expired code
    if (currentPairingCode && pairingSecondsLeft === 0) {
      currentPairingCode = null;
      if (whatsappState === 'code_ready') {
        setWhatsappState('not_linked');
      }
    }

    const recentErrors = [];
    for (const item of (rawErrors || [])) {
      try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
    }

    res.json({
      server: {
        live: true,
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version
      },
      whatsapp: {
        state: whatsappState,
        phone: activePhone,
        since: whatsappStateSince
      },
      pairing: {
        code: currentPairingCode,
        expiresAt: pairingExpiresAt,
        secondsLeft: pairingSecondsLeft
      },
      lastError,
      currentModels: {
        gemini: settings.geminiModel || DEFAULT_GEMINI_MODEL,
        groq: settings.groqModel || DEFAULT_GROQ_MODEL
      },
      services: {
        gemini: Boolean(process.env.GEMINI_API_KEY || GEMINI_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY || GROQ_API_KEY),
        upstash: upstashStatus,
        lastAiTest
      },
      events: eventLog.slice().reverse(),
      // Backward-compatible fields:
      uptime: Math.floor(process.uptime()),
      status: whatsappState,
      connectionPill: whatsappState === 'connected' ? 'Connected' : (whatsappState === 'connecting' || whatsappState === 'reconnecting' ? 'Connecting' : (whatsappState === 'code_ready' ? 'Code Ready' : 'Offline')),
      activePhone,
      isAutoPaused: isPaused,
      remainingPauseSecs,
      isManualPaused: settings.isPaused,
      consecutiveFailures,
      activeProvider: settings.provider,
      geminiModel: settings.geminiModel,
      groqModel: settings.groqModel,
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
        redis: upstashStatus === 'ok'
      }
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'STATE_FETCH_FAILED',
      hint: 'Unable to retrieve status. Ensure Upstash Redis credentials are functioning.'
    });
  }
});

async function executePairingRequest(phoneInput) {
  // 1. Strip every non-digit from the phone number
  const cleanPhone = String(phoneInput || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7 || cleanPhone.length > 15) {
    const err = new Error('Invalid phone number. Enter full international number with country code (digits only).');
    err.code = 'INVALID_PHONE';
    err.hint = 'Example: 23276123456 or 15551234567. Do not include + or spaces.';
    throw err;
  }

  if (sock?.authState?.creds?.registered) {
    const err = new Error('WhatsApp is already linked to a registered device.');
    err.code = 'ALREADY_LINKED';
    err.hint = 'To pair a new device or number, first unlink WhatsApp in Settings.';
    throw err;
  }

  // Ensure socket is initiated
  if (!sock) {
    logEvent('info', 'Starting WhatsApp socket for pairing request...');
    isSocketOpenForPairing = false;
    await startWhatsApp();
  }

  // Helper to wait until connection event shows socket is open for pairing, then wait 3s
  async function waitForReadySocket() {
    logEvent('info', 'Waiting for connection event showing socket is open for pairing...');
    await waitForSocketOpenForPairing(30000);
    logEvent('info', 'Connection event confirmed socket is open for pairing. Waiting at least 3 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Attempt 1
  try {
    await waitForReadySocket();

    // Strip every non-digit right before calling requestPairingCode
    const finalDigits = String(cleanPhone).replace(/\D/g, '');
    logEvent('info', `Requesting pairing code for +${finalDigits}...`);
    const code = await sock.requestPairingCode(finalDigits);

    currentPairingCode = code;
    pairingExpiresAt = Date.now() + 60000;
    activePhone = finalDigits;
    setWhatsappState('code_ready');
    lastError = null;
    logEvent('info', `Pairing code generated successfully: ${code} (expires in 60s)`);
    return code;
  } catch (err) {
    const errText = `${err?.message || ''} ${err?.toString() || ''}`;
    const isConnClosed = /connection closed/i.test(errText) || (err?.output?.statusCode === 428);

    if (isConnClosed) {
      logEvent('warn', 'requestPairingCode threw "Connection Closed". Waiting 15 seconds before recreating socket and retrying once...');
      setWhatsappState('reconnecting');
      await new Promise((resolve) => setTimeout(resolve, 15000));

      try {
        logEvent('info', 'Recreating WhatsApp socket for single pairing retry...');
        if (sock) {
          try { sock.end(undefined); } catch (_) {}
          sock = null;
        }
        isSocketOpenForPairing = false;
        await startWhatsApp();

        await waitForReadySocket();

        // Strip every non-digit before requestPairingCode
        const retryDigits = String(cleanPhone).replace(/\D/g, '');
        logEvent('info', `Retrying requestPairingCode for +${retryDigits}...`);
        const code = await sock.requestPairingCode(retryDigits);

        currentPairingCode = code;
        pairingExpiresAt = Date.now() + 60000;
        activePhone = retryDigits;
        setWhatsappState('code_ready');
        lastError = null;
        logEvent('info', `Pairing code generated on retry: ${code} (expires in 60s)`);
        return code;
      } catch (retryErr) {
        logEvent('error', `Pairing code retry failed: ${retryErr.message}. Stopping retry loop.`);
        lastError = {
          code: 500,
          message: 'WhatsApp connection closed during pairing attempt',
          hint: 'WhatsApp closed the pairing connection. Please wait 1 to 2 minutes, verify your phone number format (country code + number, no +), and try once more.',
          at: Date.now()
        };
        setWhatsappState('error');
        const finalErr = new Error(lastError.message);
        finalErr.code = 'PAIRING_CONNECTION_CLOSED';
        finalErr.hint = lastError.hint;
        throw finalErr;
      }
    } else {
      logEvent('error', `Pairing code request failed: ${err.message}`);
      lastError = {
        code: 500,
        message: err.message,
        hint: 'Verify phone number format. If rate-limited, wait 3 minutes before retrying.',
        at: Date.now()
      };
      setWhatsappState('error');
      const finalErr = new Error(err.message);
      finalErr.code = 'PAIRING_FAILED';
      finalErr.hint = lastError.hint;
      throw finalErr;
    }
  }
}

// POST /api/link { phone, force }
app.post('/api/link', requireAuth, async (req, res) => {
  try {
    const rawPhone = req.body.phone || req.body.phoneNumber || '';
    const digits = String(rawPhone).replace(/\D/g, '');

    if (!digits || digits.length < 7 || digits.length > 15) {
      return res.status(400).json({
        error: 'Please enter a valid phone number (country code + digits, no + sign)',
        code: 'INVALID_PHONE',
        hint: 'Example: 23276123456 or 15551234567 (digits only, no + sign, dashes, or spaces).'
      });
    }

    // Check if an unexpired code is already pending
    if (!req.body.force && currentPairingCode && pairingExpiresAt > Date.now()) {
      const secondsLeft = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
      return res.json({
        success: true,
        pairingCode: currentPairingCode,
        expiresAt: pairingExpiresAt,
        secondsLeft,
        phone: activePhone || digits
      });
    }

    if (isPairingInProgress) {
      return res.status(429).json({
        error: 'Pairing request is already in progress. Please wait a moment...',
        code: 'PAIRING_IN_PROGRESS',
        hint: 'Please wait for the current pairing attempt to complete.'
      });
    }

    isPairingInProgress = true;
    try {
      const code = await executePairingRequest(digits);
      const secondsLeft = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
      res.json({
        success: true,
        pairingCode: code,
        expiresAt: pairingExpiresAt,
        secondsLeft,
        phone: digits
      });
    } finally {
      isPairingInProgress = false;
    }
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: err.code || 'PAIRING_ERROR',
      hint: err.hint || lastError?.hint || 'Check that your phone number is correct and that WhatsApp is active on your device.'
    });
  }
});

function getAiErrorHint(status, message) {
  const msg = (message || '').toLowerCase();
  if (status === 400 || msg.includes('400') || msg.includes('invalid argument')) {
    return 'Bad model or request parameters (400). Check model name.';
  }
  if (status === 401 || status === 403 || msg.includes('401') || msg.includes('403') || msg.includes('api_key_invalid') || msg.includes('unauthorized') || msg.includes('permission denied')) {
    return 'Invalid or unauthorized API key (401/403). Check environment variable.';
  }
  if (status === 404 || msg.includes('404') || msg.includes('not found')) {
    return 'Model not found (404). Model name may be outdated or unavailable.';
  }
  if (status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
    return 'Quota or rate limit reached (429). Check account quota and billing.';
  }
  if (msg.includes('timeout') || msg.includes('aborterror')) {
    return 'Timeout after 25s = no response received from provider.';
  }
  return 'Provider error. Check server logs for details.';
}

function parseHttpError(err) {
  let status = err.status || err.statusCode || null;
  let message = err.message || String(err);

  if (!status) {
    const match = message.match(/\b(400|401|403|404|429|500|502|503)\b/);
    if (match) status = parseInt(match[1], 10);
  }

  try {
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error?.message) message = parsed.error.message;
      if (parsed.error?.code && typeof parsed.error.code === 'number') status = parsed.error.code;
    }
  } catch (_) {}

  return { status: status || 500, message, hint: getAiErrorHint(status, message) };
}

async function testGeminiProbe(modelName, timeout = 25000) {
  const start = Date.now();
  const apiKey = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: 401,
      error: 'GEMINI_API_KEY is not configured in environment',
      hint: getAiErrorHint(401, 'GEMINI_API_KEY is not configured')
    };
  }

  try {
    const res = await callGeminiWithTimeout('Test probe. Please reply with "OK".', 'You are a test probe.', modelName, timeout);
    return {
      ok: true,
      model: modelName,
      latencyMs: Date.now() - start,
      reply: res.text,
      status: 200
    };
  } catch (err) {
    const parsed = parseHttpError(err);
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: parsed.status,
      error: parsed.message,
      hint: parsed.hint
    };
  }
}

async function testGroqProbe(modelName, timeout = 25000) {
  const start = Date.now();
  const apiKey = process.env.GROQ_API_KEY || GROQ_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: 401,
      error: 'GROQ_API_KEY is not configured in environment',
      hint: getAiErrorHint(401, 'GROQ_API_KEY is not configured')
    };
  }

  try {
    const res = await callGroqWithTimeout('Test probe. Please reply with "OK".', 'You are a test probe.', modelName, timeout);
    return {
      ok: true,
      model: modelName,
      latencyMs: Date.now() - start,
      reply: res.text,
      status: 200
    };
  } catch (err) {
    const parsed = parseHttpError(err);
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: parsed.status,
      error: parsed.message,
      hint: parsed.hint
    };
  }
}

// POST /api/test-ai - Tests Gemini and Groq separately with 25s timeout
app.post('/api/test-ai', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const geminiModel = settings.geminiModel || DEFAULT_GEMINI_MODEL;
    const groqModel = settings.groqModel || DEFAULT_GROQ_MODEL;

    logEvent('info', `Running separate AI probe tests (25s timeout) for Gemini (${geminiModel}) and Groq (${groqModel})...`);

    const [geminiResult, groqResult] = await Promise.all([
      testGeminiProbe(geminiModel, 25000),
      testGroqProbe(groqModel, 25000)
    ]);

    lastAiTest = {
      gemini: geminiResult,
      groq: groqResult,
      testedAt: Date.now()
    };

    logEvent('info', `AI probe tests finished. Gemini: ${geminiResult.ok ? 'OK' : 'FAIL'} (${geminiResult.latencyMs}ms), Groq: ${groqResult.ok ? 'OK' : 'FAIL'} (${groqResult.latencyMs}ms)`);

    res.json({
      success: true,
      gemini: geminiResult,
      groq: groqResult,
      testedAt: lastAiTest.testedAt
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'TEST_AI_ERROR',
      hint: 'Could not complete AI probe tests.'
    });
  }
});

// GET /api/models - Dynamic Live Model Listing with 10min Cache
let cachedModels = null;
let lastModelsFetch = 0;
const MODELS_CACHE_TTL = 10 * 60 * 1000;

app.get('/api/models', requireAuth, async (req, res) => {
  const force = req.query.refresh === 'true';
  const now = Date.now();
  if (!force && cachedModels && (now - lastModelsFetch < MODELS_CACHE_TTL)) {
    return res.json(cachedModels);
  }

  let geminiModels = [];
  let groqModels = [];
  let geminiWarning = null;
  let groqWarning = null;

  // Google Models
  const gKey = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
  if (gKey) {
    try {
      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${gKey}`, {
        headers: { 'x-goog-api-key': gKey }
      });
      if (gRes.ok) {
        const data = await gRes.json();
        if (Array.isArray(data.models)) {
          geminiModels = data.models
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => (m.name || '').replace(/^models\//, ''))
            .filter(name => name.startsWith('gemini') && !name.includes('embedding') && !name.includes('aqa') && !name.includes('imagen'));
        }
      } else {
        geminiWarning = `Google returned status ${gRes.status}`;
      }
    } catch (e) {
      geminiWarning = e.message;
    }
  }

  const defaultGemini = ['gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  for (const m of defaultGemini) {
    if (!geminiModels.includes(m)) geminiModels.push(m);
  }

  // Groq Models
  const qKey = process.env.GROQ_API_KEY || GROQ_API_KEY;
  if (qKey) {
    try {
      const qRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${qKey}` }
      });
      if (qRes.ok) {
        const data = await qRes.json();
        if (Array.isArray(data.data)) {
          groqModels = data.data
            .filter(m => m.active !== false)
            .map(m => m.id)
            .filter(id => !id.includes('whisper') && !id.includes('embed') && !id.includes('tts') && !id.includes('guard'));
        }
      } else {
        groqWarning = `Groq returned status ${qRes.status}`;
      }
    } catch (e) {
      groqWarning = e.message;
    }
  }

  const defaultGroq = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
  for (const m of defaultGroq) {
    if (!groqModels.includes(m)) groqModels.push(m);
  }

  cachedModels = {
    gemini: geminiModels,
    groq: groqModels,
    defaultGemini: DEFAULT_GEMINI_MODEL,
    fallbackGemini: FALLBACK_GEMINI_MODEL,
    defaultGroq: DEFAULT_GROQ_MODEL,
    cachedAt: now,
    warnings: {
      gemini: geminiWarning,
      groq: groqWarning
    }
  };
  lastModelsFetch = now;

  res.json(cachedModels);
});

// POST /api/reconnect-wa
app.post('/api/reconnect-wa', requireAuth, async (req, res) => {
  try {
    logEvent('info', 'Manual reconnect requested from dashboard.');
    reconnectAttempts = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sock) {
      try { sock.end(undefined); } catch (_) {}
    }
    setWhatsappState('connecting');
    startWhatsApp();
    res.json({
      success: true,
      message: 'Reconnecting WhatsApp socket...',
      state: whatsappState
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RECONNECT_FAILED',
      hint: 'Try again in a few seconds or check server logs in Settings.'
    });
  }
});

// GET /api/cfg and POST /api/cfg
app.get('/api/cfg', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings(true);
    res.json(settings);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONFIG_FETCH_FAILED',
      hint: 'Could not load configuration from Redis.'
    });
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
    logEvent('info', 'Configuration updated successfully.');
    res.json({ success: true, message: 'Configuration saved successfully' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONFIG_SAVE_FAILED',
      hint: 'Unable to write settings to Redis. Check database connection.'
    });
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
    res.status(500).json({
      error: err.message,
      code: 'CHATS_FETCH_FAILED',
      hint: 'Failed to retrieve active chat list.'
    });
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
    res.status(500).json({
      error: err.message,
      code: 'CHAT_DETAIL_FAILED',
      hint: 'Failed to retrieve conversation details.'
    });
  }
});

// POST /api/chats/:jid/takeover
app.post('/api/chats/:jid/takeover', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.set(`handoff:${jid}`, 'manual_takeover');
    logEvent('info', `Human takeover activated for ${jid}`);
    res.json({ success: true, message: `Bot paused for ${jid}. Human takeover active.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'TAKEOVER_FAILED',
      hint: 'Unable to update handoff status in Redis.'
    });
  }
});

// POST /api/chats/:jid/resume
app.post('/api/chats/:jid/resume', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.del(`handoff:${jid}`);
    logEvent('info', `Bot resumed for ${jid}`);
    res.json({ success: true, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RESUME_FAILED',
      hint: 'Unable to remove handoff status in Redis.'
    });
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
    res.status(500).json({
      error: err.message,
      code: 'STATS_FAILED',
      hint: 'Could not fetch telemetry stats.'
    });
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
    logEvent('info', 'All contact chat memory and summaries cleared.');
    res.json({ success: true, message: 'All contact chat memory and summaries cleared.' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CLEAR_MEMORY_FAILED',
      hint: 'Error deleting keys from Redis.'
    });
  }
});

// POST /api/logout-wa
app.post('/api/logout-wa', requireAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    await clearWhatsAppAuth();
    setWhatsappState('not_linked');
    currentPairingCode = null;
    pairingExpiresAt = 0;
    lastError = null;
    logEvent('info', 'WhatsApp session disconnected and credentials wiped by user request.');
    res.json({ success: true, message: 'Logged out and wa:* keys cleared from Redis' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'LOGOUT_FAILED',
      hint: 'Could not gracefully log out socket. Try reconnecting.'
    });
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

// Keep-Awake Self-Ping every 4 minutes if RENDER_EXTERNAL_URL is set
if (RENDER_EXTERNAL_URL) {
  const pingUrl = `${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/health`;
  logEvent('info', `Keep-awake initialized: self-pinging ${pingUrl} every 4 minutes.`);
  setInterval(async () => {
    try {
      const resp = await fetch(pingUrl);
      if (!resp.ok) {
        logEvent('warn', `Keep-awake self-ping returned status ${resp.status}`);
      }
    } catch (e) {
      logEvent('warn', `Keep-awake self-ping failed: ${e.message}`);
    }
  }, 4 * 60 * 1000);
}

// Startup: check if registered session exists before connecting
async function initWhatsAppOnStartup() {
  try {
    const rawCreds = await redis.get('wa:creds');
    if (rawCreds) {
      const parsed = JSON.parse(rawCreds, BufferJSON.reviver);
      if (parsed?.registered) {
        logEvent('info', 'Found existing registered WhatsApp session. Connecting...');
        setWhatsappState('connecting');
        startWhatsApp();
        return;
      }
    }
    logEvent('info', 'No registered WhatsApp session found in Redis. Awaiting user pairing.');
    setWhatsappState('not_linked');
  } catch (e) {
    logEvent('warn', `Startup session check error: ${e.message}`);
    setWhatsappState('not_linked');
  }
}

// Start Express and WhatsApp
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` JTech Assistant backend running on port ${PORT}`);
  console.log(` Dashboard URL: http://localhost:${PORT}`);
  console.log(` Health check URL: http://localhost:${PORT}/health`);
  console.log(` CORS Allowed Origin: ${ALLOWED_ORIGIN}`);
  console.log(` Node Runtime: ${process.version}`);
  console.log(`====================================================`);

  logEvent('info', `Node runtime version: ${process.version}`);
  logEvent('info', `Startup API Keys configured: Gemini=${Boolean(GEMINI_API_KEY)}, Groq=${Boolean(GROQ_API_KEY)}, Upstash=${Boolean(UPSTASH_URL && UPSTASH_TOKEN)}`);

  initWhatsAppOnStartup().catch((err) => {
    logEvent('error', `Background WhatsApp startup error: ${err.message}`);
  });

  // Run quick Gemini and Groq probe tests in background so the first error appears in logs right away
  setImmediate(async () => {
    try {
      const settings = await getSettings();
      const [gRes, qRes] = await Promise.all([
        testGeminiProbe(settings.geminiModel || DEFAULT_GEMINI_MODEL, 12000),
        testGroqProbe(settings.groqModel || DEFAULT_GROQ_MODEL, 12000)
      ]);
      if (gRes.ok) {
        logEvent('info', `Startup Gemini probe OK (${gRes.model}, ${gRes.latencyMs}ms)`);
      } else {
        logEvent('error', `Startup Gemini probe FAILED (${gRes.status}): ${gRes.error} — ${gRes.hint}`);
      }
      if (qRes.ok) {
        logEvent('info', `Startup Groq probe OK (${qRes.model}, ${qRes.latencyMs}ms)`);
      } else {
        logEvent('error', `Startup Groq probe FAILED (${qRes.status}): ${qRes.error} — ${qRes.hint}`);
      }
    } catch (e) {
      logEvent('warn', `Startup AI probe check error: ${e.message}`);
    }
  });
});
