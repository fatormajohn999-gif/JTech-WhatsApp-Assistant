import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { state } from '../state.js';
import { getSettings } from '../lib/settings.js';
import { buildPrompt } from '../brain/prompt-builder.js';
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  GEMINI_API_KEY,
  GROQ_API_KEY,
  MODELS_CACHE_TTL,
  AI_CALL_TIMEOUT_MS
} from '../config.js';
import { callGeminiWithTimeout, testGeminiProbe } from './gemini.js';
import { callGroqWithTimeout, testGroqProbe } from './groq.js';

export { testGeminiProbe, testGroqProbe };

export function buildAlternatingTurns(messages, latestUserText) {
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

export async function checkAutoPause() {
  const until = await redis.get('autopause:until');
  if (until) {
    state.autoPauseUntil = parseInt(until, 10) || 0;
  }
  return Date.now() < state.autoPauseUntil;
}

export async function recordAiFailure(provider, errorMsg) {
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

export async function handleBothProvidersFailed(summary) {
  state.consecutiveFailures += 1;
  logEvent('warn', `Consecutive AI failure count: ${state.consecutiveFailures}/3`);
  if (state.consecutiveFailures >= 3) {
    state.autoPauseUntil = Date.now() + 10 * 60 * 1000;
    await redis.set('autopause:until', String(state.autoPauseUntil));
    await recordAiFailure('System (Auto-Pause)', `Paused replies for 10 min after 3 dual-failures: ${summary}`);
    logEvent('error', `Auto-pause triggered! Replies paused until ${new Date(state.autoPauseUntil).toLocaleTimeString()}`);
  }
}

export async function handleAiSuccess(provider) {
  state.consecutiveFailures = 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await Promise.all([
      redis.incr(`stats:replies:${today}`),
      redis.incr(`stats:provider:${provider.toLowerCase()}`)
    ]);
  } catch (_) {}
}

async function callProvider(provider, turns, systemInstruction, modelName, timeoutMs) {
  if (provider === 'gemini') {
    return await callGeminiWithTimeout(turns, systemInstruction, modelName, timeoutMs);
  } else {
    return await callGroqWithTimeout(turns, systemInstruction, modelName, timeoutMs);
  }
}

export async function generateAiReply(turns, promptBuilderArgs) {
  const settings = await getSettings();

  if (settings.isPaused) {
    return { text: null, paused: true, reason: 'Manual pause active' };
  }

  if (await checkAutoPause()) {
    const remainingSecs = Math.max(0, Math.ceil((state.autoPauseUntil - Date.now()) / 1000));
    return { text: null, paused: true, remainingSecs, reason: 'Auto-pause active' };
  }

  const systemInstruction = buildPrompt({
    personalPrompt: settings.personalPrompt,
    profile: settings.profile,
    contactFacts: promptBuilderArgs.contactFacts,
    chatSummary: promptBuilderArgs.chatSummary,
    senderJid: promptBuilderArgs.senderJid,
    contactName: promptBuilderArgs.contactName,
    contactProfile: promptBuilderArgs.contactProfile,
    contactSettings: promptBuilderArgs.contactSettings,
    lastSpokeText: promptBuilderArgs.lastSpokeText,
    ownerLearnedStyle: promptBuilderArgs.ownerLearnedStyle,
    learnedExamples: promptBuilderArgs.learnedExamples,
    ownerKnowledge: promptBuilderArgs.ownerKnowledge
  });

  const primary = (settings.provider || 'gemini').toLowerCase();
  const fallback = primary === 'gemini' ? 'groq' : 'gemini';
  const primaryModel = primary === 'gemini'
    ? (settings.geminiModel || DEFAULT_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);
  const fallbackModel = fallback === 'gemini'
    ? (settings.geminiModel || FALLBACK_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);

  const timeoutMs = state.isFirstAiCall ? 20000 : AI_CALL_TIMEOUT_MS;
  state.isFirstAiCall = false;

  try {
    const result = await callProvider(primary, turns, systemInstruction, primaryModel, timeoutMs);
    await handleAiSuccess(primary);
    return { text: result.text, provider: primary, fallbackUsed: false };
  } catch (primaryErr) {
    logEvent('warn', `Primary ${primary} failed after retry: ${primaryErr.message}`);
    await recordAiFailure(primary, primaryErr.message);

    try {
      const fallbackResult = await callProvider(fallback, turns, systemInstruction, fallbackModel, AI_CALL_TIMEOUT_MS);
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

/**
 * General-purpose AI completion runner for internal features (style analysis, summary, teach-me answers)
 */
export async function runAiCompletion(userPrompt, systemInstruction = '', timeoutMs = 25000) {
  const settings = await getSettings();
  const primary = (settings.provider || 'gemini').toLowerCase();
  const fallback = primary === 'gemini' ? 'groq' : 'gemini';
  const primaryModel = primary === 'gemini'
    ? (settings.geminiModel || DEFAULT_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);
  const fallbackModel = fallback === 'gemini'
    ? (settings.geminiModel || FALLBACK_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);

  const turns = [{ role: 'user', text: userPrompt }];

  try {
    const res = await callProvider(primary, turns, systemInstruction, primaryModel, timeoutMs);
    return res.text;
  } catch (primaryErr) {
    try {
      const fb = await callProvider(fallback, turns, systemInstruction, fallbackModel, timeoutMs);
      return fb.text;
    } catch (fallbackErr) {
      throw new Error(`AI completion failed on both providers: ${primaryErr.message} / ${fallbackErr.message}`);
    }
  }
}

let cachedModels = null;
let lastModelsFetch = 0;

export async function getAvailableModels(force = false) {
  const now = Date.now();
  if (!force && cachedModels && (now - lastModelsFetch < MODELS_CACHE_TTL)) {
    return cachedModels;
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
            .filter(name => name.startsWith('gemini') && !name.includes('embedding') && !name.includes('aqa') && !name.includes('imagen') && !name.includes('2.5'));
        }
      } else {
        geminiWarning = `Google returned status ${gRes.status}`;
      }
    } catch (e) {
      geminiWarning = e.message;
    }
  }

  const defaultGemini = [DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL, 'gemini-flash-latest'];
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
            .filter(id => !id.includes('whisper') && !id.includes('embed') && !id.includes('tts') && !id.includes('guard') && !id.includes('llama-3.3-70b-versatile'));
        }
      } else {
        groqWarning = `Groq returned status ${qRes.status}`;
      }
    } catch (e) {
      groqWarning = e.message;
    }
  }

  const defaultGroq = [DEFAULT_GROQ_MODEL, 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
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

  return cachedModels;
}
