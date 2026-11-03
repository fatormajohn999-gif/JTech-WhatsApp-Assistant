import { GROQ_API_KEY, DEFAULT_GROQ_MODEL, AI_CALL_TIMEOUT_MS } from '../config.js';
import { logEvent } from '../lib/logger.js';
import { parseHttpError, getAiErrorHint } from './gemini.js';

async function executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs) {
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
 * Call Groq with timeout and 1 automatic retry on 503 or timeout.
 */
export async function callGroqWithTimeout(turnsOrText, systemInstruction, modelName = DEFAULT_GROQ_MODEL, timeoutMs = AI_CALL_TIMEOUT_MS) {
  try {
    return await executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs);
  } catch (err) {
    const errText = (err.message || '').toLowerCase();
    const isTimeout = /timeout|aborterror/i.test(errText);
    const is503 = /503|overloaded|unavailable/i.test(errText);

    if (isTimeout || is503) {
      logEvent('warn', `Groq returned ${isTimeout ? 'timeout' : '503/overload'}. Retrying once before fallback...`);
      return await executeGroqRequest(turnsOrText, systemInstruction, modelName, timeoutMs);
    }
    throw err;
  }
}

/**
 * Diagnostic test probe for Groq.
 */
export async function testGroqProbe(modelName = DEFAULT_GROQ_MODEL, timeout = 25000) {
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
      hint: getAiErrorHint(parsed.status, parsed.message)
    };
  }
}
