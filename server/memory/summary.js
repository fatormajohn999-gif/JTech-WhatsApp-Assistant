import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS, DEFAULT_GEMINI_MODEL } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { callGeminiWithTimeout } from '../ai/gemini.js';
import { extractContactFacts } from './facts.js';

export async function triggerRollingSummary(jid) {
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
