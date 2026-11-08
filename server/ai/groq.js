import { DEFAULT_GROQ_MODEL, AI_CALL_TIMEOUT_MS } from '../config.js';
import { logEvent } from '../lib/logger.js';
import { getEffectiveApiKey } from '../lib/keys.js';
import { parseHttpError, getAiErrorHint } from './gemini.js';

async function executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options = {}) {
  const apiKey = await getEffectiveApiKey('groq');
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

  const temperature = typeof options?.temperature === 'number' ? options.temperature : 0.85;
  const max_tokens = options?.maxOutputTokens || options?.max_tokens || 400;

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
        max_tokens,
        temperature
      })
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text();
      const err = new Error(`Groq HTTP ${res.status}: ${errBody}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No reply choices from Groq');
    return { text: reply.trim(), provider: 'groq' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Groq timeout after ${timeoutMs}ms`);
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * Call Groq with timeout and 1 automatic retry on 429, 503, or timeout, honoring retry-after hints.
 */
export async function callGroqWithTimeout(turnsOrText, systemInstruction, modelName = DEFAULT_GROQ_MODEL, timeoutMs = AI_CALL_TIMEOUT_MS, options = {}) {
  try {
    return await executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options);
  } catch (err) {
    const errText = (err.message || '').toLowerCase();
    const isTimeout = /timeout|aborterror/i.test(errText);
    const is503 = /503|overloaded|unavailable/i.test(errText);
    const is429 = /429|rate limit|quota|tokens per minute/i.test(errText);

    if (isTimeout || is503 || is429) {
      let waitMs = 1500;
      const match = errText.match(/try again in ([\d.]+)s/);
      if (match && match[1]) {
        const parsedSecs = parseFloat(match[1]);
        if (!isNaN(parsedSecs) && parsedSecs > 0) {
          waitMs = Math.min(3500, Math.ceil(parsedSecs * 1000) + 200);
        }
      }
      logEvent('warn', `Groq returned ${is429 ? '429/rate-limit' : (isTimeout ? 'timeout' : '503')}. Waiting ${waitMs}ms to retry once before fallback...`);
      await new Promise(r => setTimeout(r, waitMs));
      return await executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs, options);
    }
    throw err;
  }
}

/**
 * Diagnostic test probe for Groq.
 */
export async function testGroqProbe(modelName = DEFAULT_GROQ_MODEL, timeout = 25000) {
  const start = Date.now();
  const apiKey = await getEffectiveApiKey('groq');
  if (!apiKey) {
    return {
      ok: false,
      model: modelName,
      latencyMs: Date.now() - start,
      status: 401,
      error: 'GROQ_API_KEY is not configured',
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
      hint: getAiErrorHint(parsed.status, parsed.message)
    };
  }
}
