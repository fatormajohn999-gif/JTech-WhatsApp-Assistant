import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS, DEFAULT_GEMINI_MODEL } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { callGeminiWithTimeout } from '../ai/gemini.js';

export async function extractContactFacts(jid, textContent) {
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
