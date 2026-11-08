import { GoogleGenAI } from '@google/genai';
import { DEFAULT_GEMINI_MODEL, AI_CALL_TIMEOUT_MS } from '../config.js';
import { logEvent } from '../lib/logger.js';
import { getEffectiveApiKey } from '../lib/keys.js';

let geminiClient = null;
let lastUsedKey = null;

async function getGeminiClient() {
  const apiKey = await getEffectiveApiKey('gemini');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  if (!geminiClient || lastUsedKey !== apiKey) {
    geminiClient = new GoogleGenAI({ apiKey });
    lastUsedKey = apiKey;
  }
  return geminiClient;
}

export function parseHttpError(err) {
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

  return { status: status || 500, message };
}

export function getAiErrorHint(status, message) {
  const msg = (message || '').toLowerCase();
  if (status === 400 || msg.includes('400') || msg.includes('invalid argument')) {
    return 'Bad model or request parameters (400). Check model name.';
  }
  if (status === 401 || status === 403 || msg.includes('401') || msg.includes('403') || msg.includes('api_key_invalid') || msg.includes('unauthorized') || msg.includes('permission denied')) {
    return 'Invalid or unauthorized API key (401/403). Check your Gemini API key in Settings.';
  }
  if (status === 404 || msg.includes('404') || msg.includes('not found')) {
    return 'Model not found (404). Model name may be outdated or unavailable.';
  }
  if (status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
    return 'Quota or rate limit reached (429). Check account quota and billing.';
  }
  if (status === 503 || msg.includes('503') || msg.includes('overloaded') || msg.includes('service unavailable')) {
    return 'Model or server overloaded (503). Retrying or using fallback.';
  }
  if (msg.includes('timeout') || msg.includes('aborterror')) {
    return 'Timeout = no response received within timeout window.';
  }
  return 'Provider error. Check server logs for details.';
}

async function executeGeminiRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options = {}) {
  const client = await getGeminiClient();

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

  const temperature = typeof options?.temperature === 'number' ? options.temperature : 0.85;
  const maxOutputTokens = options?.maxOutputTokens || 400;

  const apiPromise = client.models.generateContent({
    model: modelName,
    contents: geminiContents,
    config: {
      systemInstruction,
      temperature,
      maxOutputTokens
    }
  });

  const response = await Promise.race([apiPromise, timeoutPromise]);
  const text = response?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Empty response from Gemini');
  }
  return { text: text.trim(), provider: 'gemini' };
}

/**
 * Call Gemini with timeout and 1 automatic retry on 429, 503, or timeout.
 */
export async function callGeminiWithTimeout(turnsOrText, systemInstruction, modelName = DEFAULT_GEMINI_MODEL, timeoutMs = AI_CALL_TIMEOUT_MS, options = {}) {
  try {
    return await executeGeminiRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options);
  } catch (err) {
    const errText = (err.message || '').toLowerCase();
    const isTimeout = /timeout|aborterror/i.test(errText);
    const is503 = /503|overloaded|unavailable/i.test(errText);
    const is429 = /429|quota|rate limit|resource exhausted/i.test(errText);

    if (isTimeout || is503 || is429) {
      logEvent('warn', `Gemini returned ${is429 ? '429/quota' : (isTimeout ? 'timeout' : '503')}. Retrying once before fallback...`);
      await new Promise(r => setTimeout(r, 1200));
      return await executeGeminiRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options);
    }
    throw err;
  }
}

/**
 * Diagnostic test probe for Gemini.
 */
export async function testGeminiProbe(modelName = DEFAULT_GEMINI_MODEL, timeout = 25000) {
  const start = Date.now();
  const apiKey = await getEffectiveApiKey('gemini');
  if (!apiKey) {
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: 401,
      error: 'GEMINI_API_KEY is not configured',
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
      hint: getAiErrorHint(parsed.status, parsed.message)
    };
  }
}
