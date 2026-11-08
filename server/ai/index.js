import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { state } from '../state.js';
import { getSettings } from '../lib/settings.js';
import { getEffectiveApiKey } from '../lib/keys.js';
import { buildPrompt } from '../brain/prompt-builder.js';
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
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

  // Take the last 8 messages maximum for context and compact text
  const sliced = mapped.slice(-8).map(m => ({
    role: m.role,
    text: m.text.slice(0, 300)
  }));

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
    merged.push({ role: 'user', text: (latestUserText || 'Hello').slice(0, 300) });
  }

  return merged;
}

export async function checkAutoPause() {
  return false;
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
  state.aiLimited = {
    isLimited: true,
    reason: String(summary).slice(0, 140),
    until: Date.now() + 60000
  };
  logEvent('warn', `Both AI providers failed. AI temporarily limited for 60s. Reason: ${summary}`);
}

export async function handleAiSuccess(provider) {
  state.consecutiveFailures = 0;
  state.aiLimited = null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await Promise.all([
      redis.incr(`stats:replies:${today}`),
      redis.incr(`stats:provider:${provider.toLowerCase()}`)
    ]);
  } catch (_) {}
}

async function callProvider(provider, turns, systemInstruction, modelName, timeoutMs, options = {}) {
  if (provider === 'gemini') {
    return await callGeminiWithTimeout(turns, systemInstruction, modelName, timeoutMs, options);
  } else {
    return await callGroqWithTimeout(turns, systemInstruction, modelName, timeoutMs, options);
  }
}

export async function generateAiReply(turns, promptBuilderArgs) {
  const settings = await getSettings();

  // ONLY the owner's master switch can pause replies
  if (settings.isPaused) {
    return { text: null, paused: true, reason: 'Manual pause active' };
  }

  const systemInstruction = buildPrompt({
    personalPrompt: settings.personalPrompt,
    profile: settings.profile,
    identity: settings.identity,
    personality: settings.personality,
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

  const options = {
    temperature: settings.temperature ?? 0.85,
    maxOutputTokens: 400
  };

  try {
    const result = await callProvider(primary, turns, systemInstruction, primaryModel, timeoutMs, options);
    await handleAiSuccess(primary);
    return { text: result.text, provider: primary, fallbackUsed: false };
  } catch (primaryErr) {
    logEvent('warn', `Primary ${primary} failed after retry: ${primaryErr.message}`);
    await recordAiFailure(primary, primaryErr.message);

    try {
      const fallbackResult = await callProvider(fallback, turns, systemInstruction, fallbackModel, AI_CALL_TIMEOUT_MS, options);
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
 * General-purpose AI completion runner for internal features (style analysis, summary, teach-me answers, scheduler)
 * Accepts either:
 *   runAiCompletion(userPrompt, systemInstruction, timeoutMs)
 * OR:
 *   runAiCompletion({ userPrompt, turns, systemInstruction, timeoutMs })
 */
export async function runAiCompletion(arg1, arg2 = '', arg3 = 25000) {
  let userPrompt = '';
  let systemInstruction = '';
  let timeoutMs = 25000;
  let turns = null;

  if (typeof arg1 === 'object' && arg1 !== null) {
    systemInstruction = arg1.systemInstruction || '';
    timeoutMs = arg1.timeoutMs || 25000;
    if (Array.isArray(arg1.turns)) {
      turns = arg1.turns;
    } else {
      userPrompt = String(arg1.userPrompt || arg1.prompt || '');
    }
  } else {
    userPrompt = String(arg1 || '');
    systemInstruction = String(arg2 || '');
    timeoutMs = arg3 || 25000;
  }

  if (!turns) {
    turns = [{ role: 'user', text: userPrompt }];
  }

  const settings = await getSettings();
  const primary = (settings.provider || 'gemini').toLowerCase();
  const fallback = primary === 'gemini' ? 'groq' : 'gemini';
  const primaryModel = primary === 'gemini'
    ? (settings.geminiModel || DEFAULT_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);
  const fallbackModel = fallback === 'gemini'
    ? (settings.geminiModel || FALLBACK_GEMINI_MODEL)
    : (settings.groqModel || DEFAULT_GROQ_MODEL);

  const options = {
    temperature: settings.temperature ?? 0.85,
    maxOutputTokens: 400
  };

  try {
    const res = await callProvider(primary, turns, systemInstruction, primaryModel, timeoutMs, options);
    return res.text;
  } catch (primaryErr) {
    try {
      const fb = await callProvider(fallback, turns, systemInstruction, fallbackModel, timeoutMs, options);
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
  const gKey = await getEffectiveApiKey('gemini');
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
  const qKey = await getEffectiveApiKey('groq');
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
