/**
 * Personal WhatsApp AI Assistant - server.js
 * 
 * Features:
 * - Node 20+, ES modules, Express
 * - @whiskeysockets/baileys (linked device, pairing code login, no QR)
 * - @upstash/redis REST (automaticDeserialization: false)
 * - Dual AI: Google Gemini & Groq with 12s timeout & automatic fallback
 * - Sensitive topics guardrail (money requests, passwords, promises, meetings -> personal handoff)
 * - Owner human reply detection (silences bot for 10 minutes when owner replies personally)
 * - Intelligent Prompt Builder rebuilt on every message:
 *     1) base rules 2) owner profile (Freetown, Sierra Leone / English & Krio / custom style)
 *     3) Africa/Freetown real-time clock 4) contact facts 5) chat summary
 * - Auto-summarization every 20 messages (key sum:<jid>, max 600 chars)
 * - Typing indicator with random delay (300-1200ms editable)
 * - Timing-safe authentication for dashboard /api routes
 * - Tiny public /health route for uptime pingers
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

// Environment variables
const PORT = parseInt(process.env.PORT || '3000', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'freetown_assistant_2026';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

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
// 2. Timing-Safe Password Verification
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
// 3. 30-Second In-Memory Settings Cache
// ---------------------------------------------------------------------------
let cachedSettings = null;
let lastSettingsFetch = 0;
const SETTINGS_CACHE_TTL = 30 * 1000; // 30 seconds

const DEFAULT_PROFILE = {
  name: 'Mohamed',
  city: 'Freetown, Sierra Leone',
  timeZone: 'Africa/Freetown',
  job: 'Software Engineer & Tech Entrepreneur',
  languages: 'English, Krio',
  facts: 'Passionate about African tech innovation, building software, football, and good coffee. Friendly, respectful, direct, and thoughtful.',
  sampleMessage1: 'Kusheh! Good to hear from you. Let me check that out for you right away.',
  sampleMessage2: 'All good my friend! How are things with you today?',
  sampleMessage3: 'I will look into this and get back to you shortly. Take care!'
};

const DEFAULT_BASE_RULES = 
`You are the personal WhatsApp AI assistant for the owner described below.
Your instructions:
1. Speak on behalf of the owner in their authentic voice, personality, and tone.
2. If asked "who are you?", "is this an AI?", or "is this [Owner]?", politely explain: "I am [Owner]'s personal AI assistant. I'm here helping manage their messages, but I speak on their behalf."
3. Reply to every single private message. Never stay silent. Small talk, greetings ("kusheh", "how de body", "hello"), and questions always get a warm, thoughtful reply.
4. SENSITIVE TOPICS GUARDRAIL: If anyone asks for money (wire transfer, borrowing, payments), asks for passwords/credentials, asks for legal/formal promises, or asks to schedule an in-person meeting/appointment: DO NOT agree or make commitments. Reply politely that you will notify the owner so they can answer personally.
5. Keep WhatsApp replies natural, concise (1-3 sentences unless a detailed explanation was explicitly asked), and human. Avoid robotic phrases like "As an AI language model".`;

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

function buildPrompt({ baseRules, profile, contactFacts, chatSummary, senderJid, contactName }) {
  const timeNow = getFreetownTime();
  
  let factsSection = 'None recorded yet.';
  if (Array.isArray(contactFacts) && contactFacts.length > 0) {
    factsSection = contactFacts.map(f => `- ${f}`).join('\n');
  }

  let summarySection = chatSummary ? chatSummary : 'First conversation or no older summary yet.';

  return `
${baseRules}

=== OWNER IDENTITY & BACKGROUND ===
- Name: ${profile.name}
- Location: ${profile.city} (Time zone: ${profile.timeZone})
- Current Date & Time: ${timeNow}
- Profession: ${profile.job}
- Languages spoken: ${profile.languages}
- Key facts about owner: ${profile.facts}

=== SAMPLES OF OWNER'S VOICE & STYLE (Mimic this natural tone) ===
Sample 1: "${profile.sampleMessage1}"
Sample 2: "${profile.sampleMessage2}"
Sample 3: "${profile.sampleMessage3}"

=== THIS CONTACT ===
- Contact identifier: ${senderJid}
- Known name/phone: ${contactName || 'Friend / Contact'}
- Known facts about this person:
${factsSection}

=== RECAP OF OLDER CONVERSATION ===
${summarySection}

Answer the latest message thoughtfully in the owner's style. Keep it concise, authentic, and polite.
`.trim();
}

// ---------------------------------------------------------------------------
// 6. Memory: Last 12 Messages, Auto-Summary & Contact Facts
// ---------------------------------------------------------------------------
async function getChatMemory(jid) {
  // Parallel fetch: messages, summary, facts, handoff
  const [rawMessages, summary, rawFacts, handoffVal] = await Promise.all([
    redis.lrange(`chat:${jid}:messages`, -12, -1),
    redis.get(`sum:${jid}`),
    redis.get(`contact:${jid}:facts`),
    redis.get(`handoff:${jid}`)
  ]);

  const messages = [];
  for (const item of rawMessages) {
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

  return {
    messages,
    summary: summary || '',
    facts,
    isHandoff: Boolean(handoffVal)
  };
}

async function recordMessage(jid, role, text, fromMe = false, senderName = '') {
  try {
    const timestamp = Date.now();
    const msgObj = {
      id: `${jid}_${timestamp}_${Math.random().toString(36).substring(2, 6)}`,
      role, // 'user' or 'assistant'
      text,
      timestamp,
      fromMe,
      senderName
    };

    const listKey = `chat:${jid}:messages`;
    await redis.rpush(listKey, JSON.stringify(msgObj));
    await redis.ltrim(listKey, -50, -1); // keep last 50

    // Increment message count for auto-summary trigger
    const msgCount = await redis.incr(`contact:${jid}:msg_count`);

    // Update conversation metadata
    const handoffVal = await redis.get(`handoff:${jid}`);
    const metaKey = `chat:${jid}:meta`;
    const metaObj = {
      jid,
      name: senderName || jid.split('@')[0],
      lastMessage: text.slice(0, 100),
      timestamp,
      lastRole: role,
      isHandoff: Boolean(handoffVal)
    };
    await redis.set(metaKey, JSON.stringify(metaObj));

    // Maintain recent list (up to 30)
    const recentRaw = await redis.get('chats:recent');
    let recent = [];
    if (recentRaw) {
      try { recent = JSON.parse(recentRaw); } catch (_) {}
    }
    recent = recent.filter(j => j !== jid);
    recent.unshift(jid);
    if (recent.length > 30) recent = recent.slice(0, 30);
    await redis.set('chats:recent', JSON.stringify(recent));

    // Every 20 messages, trigger background summary update (max 600 chars)
    if (msgCount % 20 === 0) {
      triggerBackgroundSummary(jid).catch(e => console.error(`[Summary] Background task failed for ${jid}:`, e.message));
    }

    // Extract facts asynchronously if user provided new info
    if (role === 'user' && text.length > 10) {
      extractContactFacts(jid, text).catch(e => console.error(`[Facts] Error extracting for ${jid}:`, e.message));
    }
  } catch (err) {
    console.error(`[Memory] Error recording message for ${jid}:`, err.message);
  }
}

// Background auto-summary (max 600 characters)
async function triggerBackgroundSummary(jid) {
  try {
    const rawMessages = await redis.lrange(`chat:${jid}:messages`, -20, -1);
    const existingSummary = (await redis.get(`sum:${jid}`)) || 'None';
    if (!rawMessages || rawMessages.length < 5) return;

    const chatLines = rawMessages.map(m => {
      try {
        const parsed = JSON.parse(m);
        return `${parsed.role === 'assistant' ? 'Assistant' : 'Contact'}: ${parsed.text}`;
      } catch (_) {
        return m;
      }
    }).join('\n');

    const prompt = `You are a concise conversation summarizer.
Update the previous summary of this conversation with the latest messages.
PREVIOUS SUMMARY: "${existingSummary}"
LATEST CHAT:
${chatLines}

CRITICAL RULES:
1. Max 600 characters.
2. Focus on: key topics discussed, agreements, pending questions, and personal details shared.
3. Be strictly factual and concise.`;

    const res = await callGeminiWithTimeout(prompt, 'Summarize concisely under 600 characters.', 'gemini-2.5-flash', 12000);
    if (res && res.text) {
      const trimmed = res.text.slice(0, 600);
      await redis.set(`sum:${jid}`, trimmed);
      console.log(`[Summary] Updated sum:${jid} (${trimmed.length} chars)`);
    }
  } catch (err) {
    console.warn(`[Summary] Could not auto-summarize for ${jid}:`, err.message);
  }
}

// Background fact extraction (up to 10 facts)
async function extractContactFacts(jid, userText) {
  try {
    // Only extract if text has meaningful keywords (e.g. "I am", "my work", "living in", "I like", "call me")
    if (!/(i am|i'm|my name|i work|i live|i study|my phone|my email|i like|i need|my wife|my husband|my friend)/i.test(userText)) {
      return;
    }

    const rawFacts = await redis.get(`contact:${jid}:facts`);
    let facts = [];
    if (rawFacts) {
      try { facts = JSON.parse(rawFacts); } catch (_) {}
    }

    const prompt = `Extract any permanent facts about this contact (e.g., their name, location, occupation, family, preferences) from their message.
Existing facts:
${facts.map(f => `- ${f}`).join('\n')}

New message: "${userText}"

Reply ONLY with a JSON array of up to 10 strings representing the updated facts. Example: ["Name is Alpha", "Lives in Aberdeen", "Software student"]. If no new facts, return existing facts.`;

    const res = await callGeminiWithTimeout(prompt, 'Output JSON array only.', 'gemini-2.5-flash', 8000);
    if (res && res.text) {
      const match = res.text.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const cleanFacts = parsed.slice(0, 10).map(s => String(s).trim());
          await redis.set(`contact:${jid}:facts`, JSON.stringify(cleanFacts));
          console.log(`[Facts] Saved ${cleanFacts.length} facts for ${jid}`);
        }
      }
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 7. AI Providers: Gemini & Groq with 12s Timeout & Fallback
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
    autoPauseUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
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

// 12-second timeout wrapper for Gemini
let geminiClient = null;
async function callGeminiWithTimeout(userText, systemInstruction, modelName = 'gemini-2.5-flash', timeoutMs = 12000) {
  if (!GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || GEMINI_API_KEY });
  }

  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Gemini timeout after ${timeoutMs}ms`)), timeoutMs)
  );

  const apiPromise = geminiClient.models.generateContent({
    model: modelName,
    contents: userText,
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

// 12-second timeout wrapper for Groq
async function callGroqWithTimeout(userText, systemInstruction, modelName = 'llama-3.3-70b-versatile', timeoutMs = 12000) {
  const apiKey = process.env.GROQ_API_KEY || GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured');
  }

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
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userText }
        ],
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

// High-level AI runner with automatic fallback
async function generateAiReply(userText, promptBuilderArgs) {
  const settings = await getSettings();

  if (settings.isPaused) {
    return { text: null, paused: true, reason: 'Dashboard manual pause active' };
  }

  if (await checkAutoPause()) {
    const remainingSecs = Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000));
    return { text: null, paused: true, remainingSecs, reason: 'Auto-pause after 3 consecutive failures' };
  }

  const systemInstruction = buildPrompt({
    baseRules: settings.baseRules,
    profile: settings.profile,
    contactFacts: promptBuilderArgs.contactFacts,
    chatSummary: promptBuilderArgs.chatSummary,
    senderJid: promptBuilderArgs.senderJid,
    contactName: promptBuilderArgs.contactName
  });

  const primary = (settings.provider || 'gemini').toLowerCase();
  const fallback = primary === 'gemini' ? 'groq' : 'gemini';

  // Primary attempt
  try {
    let result;
    if (primary === 'gemini') {
      result = await callGeminiWithTimeout(userText, systemInstruction, settings.geminiModel, 12000);
    } else {
      result = await callGroqWithTimeout(userText, systemInstruction, settings.groqModel, 12000);
    }
    await handleAiSuccess(primary);
    return { text: result.text, provider: primary, fallbackUsed: false };
  } catch (primaryErr) {
    console.warn(`[AI] Primary ${primary} failed:`, primaryErr.message);
    await recordAiFailure(primary, primaryErr.message);

    // Fallback attempt
    try {
      let fallbackResult;
      if (fallback === 'gemini') {
        fallbackResult = await callGeminiWithTimeout(userText, systemInstruction, settings.geminiModel, 12000);
      } else {
        fallbackResult = await callGroqWithTimeout(userText, systemInstruction, settings.groqModel, 12000);
      }
      await handleAiSuccess(fallback);
      console.log(`[AI] Fallback ${fallback} succeeded!`);
      return { text: fallbackResult.text, provider: fallback, fallbackUsed: true };
    } catch (fallbackErr) {
      console.error(`[AI] Fallback ${fallback} also failed:`, fallbackErr.message);
      await recordAiFailure(fallback, fallbackErr.message);
      await handleBothProvidersFailed(`${primary}: ${primaryErr.message} | ${fallback}: ${fallbackErr.message}`);
      throw new Error(`Both AI providers failed. ${primary}: ${primaryErr.message}. ${fallback}: ${fallbackErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Baileys WhatsApp Connection & Human Reply Detection
// ---------------------------------------------------------------------------
let sock = null;
let connectionStatus = 'disconnected';
let currentPairingCode = null;
let activePhone = PHONE_NUMBER || process.env.PHONE_NUMBER || '';

// Track messages sent by this bot to distinguish from human owner replies
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
      browser: ['Personal AI Assistant', 'Chrome', '124.0.0'],
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
        console.log('[WhatsApp] Connection opened successfully! Bot ready.');
      } else if (connection === 'close') {
        connectionStatus = 'disconnected';
        currentPairingCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[WhatsApp] Connection closed (status: ${statusCode}). Logged out: ${loggedOut}`);

        if (loggedOut) {
          console.warn('[WhatsApp] Session logged out. Clearing wa:* keys from Redis...');
          await clearWhatsAppAuth();
          // Request new pairing code if phone available
          setTimeout(() => startWhatsApp(activePhone), 4000);
        } else {
          // Reconnect automatically
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

    // Request pairing code if phone provided and not yet registered
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
// 9. Core Incoming Message Pipeline
// ---------------------------------------------------------------------------
async function handleIncomingMessage(m) {
  if (!m || !m.message) return;

  const senderJid = m.key.remoteJid || '';
  if (!senderJid) return;

  // 1. Never reply to groups (@g.us), broadcasts (@broadcast), or newsletters (@newsletter)
  if (senderJid.endsWith('@g.us')) return;
  if (senderJid.includes('@broadcast') || senderJid === 'status@broadcast') return;
  if (senderJid.endsWith('@newsletter')) return;

  const msgId = m.key.id;

  // 2. OWNER DIRECT HUMAN REPLY DETECTION
  // If the message is fromMe:
  if (m.key.fromMe) {
    // If the bot sent it, ignore
    if (botSentMessageIds.has(msgId)) {
      return;
    }
    // If NOT sent by bot, this was sent personally by the owner on their phone!
    // Silence bot for that person for 10 minutes:
    const silenceUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
    await redis.set(`handoff:${senderJid}`, String(silenceUntil), { ex: 600 });
    console.log(`[Human Reply] Owner replied directly to ${senderJid}. Silencing bot for 10 minutes.`);
    
    // Record owner message in memory so assistant knows context later
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Owner sent media]';
    await recordMessage(senderJid, 'user', text, true, 'Owner (You)');
    return;
  }

  // 3. Check if Handoff is active (either manual takeover or 10-minute owner direct reply)
  const handoffVal = await redis.get(`handoff:${senderJid}`);
  if (handoffVal) {
    const until = parseInt(handoffVal, 10);
    if (!isNaN(until) && Date.now() < until) {
      const remainingMins = Math.ceil((until - Date.now()) / 60000);
      console.log(`[Handoff] Active silence for ${senderJid} (${remainingMins}m remaining). Skipping bot reply.`);
      // Still record contact message
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    } else if (isNaN(until)) {
      // Manual takeover without expiration
      console.log(`[Handoff] Manual takeover active for ${senderJid}. Skipping bot reply.`);
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    }
  }

  // 4. Contact Rules: Allowlist / Blocklist / All
  const settings = await getSettings();
  const rules = settings.contactRules || { mode: 'all', allowlist: [], blocklist: [] };
  const phone = jidToPhone(senderJid);

  if (rules.mode === 'allowlist') {
    if (!matchesContactRule(senderJid, rules.allowlist, phone)) {
      console.log(`[Filter] ${senderJid} not in allowlist. Ignoring.`);
      return;
    }
  } else if (rules.mode === 'blocklist') {
    if (matchesContactRule(senderJid, rules.blocklist, phone)) {
      console.log(`[Filter] ${senderJid} is in blocklist. Ignoring.`);
      return;
    }
  }

  const pushName = m.pushName || '';
  const msgContent = m.message;

  // 5. Voice notes and images: reply politely asking for text
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
    return; // ignore stickers
  }

  if (isMedia && !userText.trim()) {
    const politeReply = `Hello! I am ${settings.profile.name}'s assistant. I cannot listen to voice notes or view photos right now. Please send your message as text, and I'll be happy to help! 🙏`;
    await recordMessage(senderJid, 'user', '[Voice note or Image received]', false, pushName);
    
    // Typing indicator
    await sock.sendPresenceUpdate('composing', senderJid);
    await new Promise(r => setTimeout(r, 600));
    await sock.sendPresenceUpdate('paused', senderJid);

    const sent = await sock.sendMessage(senderJid, { text: politeReply }, { quoted: m });
    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    await recordMessage(senderJid, 'assistant', politeReply, true, 'Assistant');
    return;
  }

  // Must have text
  if (!userText || !userText.trim()) return;
  const cleanText = userText.trim();

  // Save incoming user message
  await recordMessage(senderJid, 'user', cleanText, false, pushName);

  // 6. Fetch Contact Memory in parallel (chat history, summary, facts)
  const memory = await getChatMemory(senderJid);

  // 7. Show Typing Indicator right away
  await sock.sendPresenceUpdate('composing', senderJid);

  // 8. Generate AI Reply with Intelligent Prompt Builder
  try {
    const aiResult = await generateAiReply(cleanText, {
      contactFacts: memory.facts,
      chatSummary: memory.summary,
      senderJid,
      contactName: pushName || phone
    });

    if (aiResult.paused) {
      await sock.sendPresenceUpdate('paused', senderJid);
      console.log(`[Reply] Paused for ${senderJid}: ${aiResult.reason}`);
      return;
    }

    if (aiResult.text) {
      // Random delay (300ms - 1200ms editable)
      const minD = Math.max(100, settings.minDelay);
      const maxD = Math.max(minD, settings.maxDelay);
      const delay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
      await new Promise(r => setTimeout(r, delay));

      await sock.sendPresenceUpdate('paused', senderJid);

      // Send reply
      const sent = await sock.sendMessage(senderJid, { text: aiResult.text }, { quoted: m });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        // prune bot sent cache if large
        if (botSentMessageIds.size > 2000) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }

      await recordMessage(senderJid, 'assistant', aiResult.text, true, `AI (${aiResult.provider})`);
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
// 10. Express Server & Timing-Safe Dashboard API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Tiny public /health route for uptime pinger
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    whatsapp: connectionStatus
  });
});

// Timing-safe authentication middleware for /api routes
function requireTimingSafeAuth(req, res, next) {
  const pass = req.headers['x-pass'] || req.query.pass;
  if (!pass || !timingSafeEqualStr(String(pass), String(DASHBOARD_PASSWORD))) {
    return res.status(401).json({ error: 'Unauthorized: Invalid x-pass header' });
  }
  next();
}

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

// API: System & Connection Status
app.get('/api/status', requireTimingSafeAuth, async (req, res) => {
  try {
    const isPaused = await checkAutoPause();
    const remainingPauseSecs = isPaused ? Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000)) : 0;
    const settings = await getSettings();

    res.json({
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
      freetownTime: getFreetownTime(),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || GEMINI_API_KEY),
      hasGroqKey: Boolean(process.env.GROQ_API_KEY || GROQ_API_KEY),
      hasRedis: Boolean(redis.isUpstash)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Request Pairing Code
app.post('/api/pair', requireTimingSafeAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    const digits = cleanDigits(phone);
    if (!digits) {
      return res.status(400).json({ error: 'Please enter a valid phone number with country code' });
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
      return res.json({ success: true, message: 'Initiating pairing... refresh in a few seconds', phone: digits });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp Logout & Clear Auth
app.post('/api/logout', requireTimingSafeAuth, async (req, res) => {
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

// API: Get Full Settings (Profile, Rules, Delays, Contacts)
app.get('/api/settings', requireTimingSafeAuth, async (req, res) => {
  try {
    const settings = await getSettings(true);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Save Settings
app.post('/api/settings', requireTimingSafeAuth, async (req, res) => {
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
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Live Chat - Latest 30 Conversations
app.get('/api/chats', requireTimingSafeAuth, async (req, res) => {
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

// API: Live Chat - Last 12 Messages of a Conversation
app.get('/api/chats/:jid/messages', requireTimingSafeAuth, async (req, res) => {
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
      messages: memory.messages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Per-Contact Take Over
app.post('/api/chats/:jid/takeover', requireTimingSafeAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    // Set handoff indefinite until manual resume
    await redis.set(`handoff:${jid}`, 'manual_takeover');
    res.json({ success: true, message: `Bot paused for ${jid}. Human takeover active.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Per-Contact Resume Bot
app.post('/api/chats/:jid/resume', requireTimingSafeAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.del(`handoff:${jid}`);
    res.json({ success: true, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Clear Memory for Contact
app.post('/api/chats/:jid/clear-memory', requireTimingSafeAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await Promise.all([
      redis.del(`chat:${jid}:messages`),
      redis.del(`sum:${jid}`),
      redis.del(`contact:${jid}:facts`),
      redis.del(`contact:${jid}:msg_count`)
    ]);
    res.json({ success: true, message: `Memory cleared for ${jid}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Global Memory Clear
app.post('/api/clear-all-memory', requireTimingSafeAuth, async (req, res) => {
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

// API: Usage Panel & AI Errors
app.get('/api/usage', requireTimingSafeAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [repliesToday, geminiCount, groqCount, rawErrors, isAutoPaused] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4),
      checkAutoPause()
    ]);

    const recentErrors = [];
    for (const item of rawErrors) {
      try {
        recentErrors.push(JSON.parse(item));
      } catch (_) {
        recentErrors.push({ message: item, timestamp: Date.now() });
      }
    }

    const remainingPauseSecs = isAutoPaused ? Math.max(0, Math.ceil((autoPauseUntil - Date.now()) / 1000)) : 0;

    res.json({
      repliesToday: parseInt(repliesToday || '0', 10),
      providers: {
        gemini: parseInt(geminiCount || '0', 10),
        groq: parseInt(groqCount || '0', 10)
      },
      consecutiveFailures,
      isAutoPaused,
      remainingPauseSecs,
      recentErrors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Resume Auto-Pause
app.post('/api/autopause/resume', requireTimingSafeAuth, async (req, res) => {
  try {
    consecutiveFailures = 0;
    autoPauseUntil = 0;
    await redis.del('autopause:until');
    res.json({ success: true, message: 'Auto-pause lifted. Replies resumed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 11. Start Express Server & WhatsApp
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` Personal WhatsApp AI Assistant running on port ${PORT}`);
  console.log(` Dashboard URL: http://localhost:${PORT}`);
  console.log(` Health check URL: http://localhost:${PORT}/health`);
  console.log(` Target platform: Render Web Service`);
  console.log(`====================================================`);

  startWhatsApp().catch((err) => {
    console.error('[WhatsApp] Background start error:', err.message);
  });
});
