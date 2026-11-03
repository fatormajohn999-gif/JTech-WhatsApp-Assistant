import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { CONTACT_TTL_SECONDS, DEFAULT_GEMINI_MODEL } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { callGeminiWithTimeout } from '../ai/gemini.js';

export async function triggerRollingSummary(jid) {
  try {
    const [rawMessages, existingSummary, rawFacts, rawProfile] = await Promise.all([
      redis.lrange(`chat:${jid}:messages`, -20, -1),
      redis.get(`sum:${jid}`),
      redis.get(`contact:${jid}:facts`),
      redis.get(`contact:${jid}:profile`)
    ]);

    if (!rawMessages || rawMessages.length < 3) return;

    let existingFacts = [];
    if (rawFacts) {
      try { existingFacts = JSON.parse(rawFacts); } catch (_) {}
    }

    const chatLines = rawMessages.map(m => {
      try {
        const parsed = JSON.parse(m);
        return `${parsed.role === 'assistant' ? 'Owner' : 'Contact'}: ${parsed.text}`;
      } catch (_) {
        return m;
      }
    }).join('\n');

    const prompt = `You are a background conversation analyzer and memory manager for personal WhatsApp messaging.
Analyze this chat between the owner and the contact.

PREVIOUS SUMMARY: "${existingSummary || 'None'}"
EXISTING KNOWN FACTS:
${existingFacts.length > 0 ? existingFacts.map(f => `- ${f}`).join('\n') : 'None'}

NEWEST CHAT MESSAGES:
${chatLines}

CRITICAL TASK:
Return ONLY a valid JSON object (no markdown, no backticks, no extra text) with these three keys:
1. "summary": Merge previous context with the newest conversation messages into one cohesive rolling summary (string, max 500 characters). Cover topics, open questions, and the contact's tone/mood.
2. "language": The contact's primary language or dialect detected from their actual messages (e.g. "English", "Krio", "French", "Spanish", etc.). Default to "English" if unclear.
3. "facts": An array of strings containing permanent, useful facts about this contact (name, location, occupation, relationship notes, preferences). Deduplicate with existing facts. Maximum 10 items.`;

    const settings = await getSettings();
    const model = settings.geminiModel || DEFAULT_GEMINI_MODEL;
    const res = await callGeminiWithTimeout(prompt, 'Return JSON object with keys: summary, language, facts. No explanation.', model, 15000);

    if (res && res.text) {
      let parsed = null;
      try {
        const cleanJson = res.text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleanJson);
      } catch (_) {
        const match = res.text.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch (_) {}
        }
      }

      if (parsed) {
        // 1. Update rolling summary
        if (parsed.summary && typeof parsed.summary === 'string') {
          const trimmedSum = parsed.summary.trim().slice(0, 600);
          await redis.set(`sum:${jid}`, trimmedSum, { ex: CONTACT_TTL_SECONDS });
          logEvent('info', `Updated summary for ${jid} (${trimmedSum.length} chars)`);
        }

        // 2. Update contact facts
        if (Array.isArray(parsed.facts)) {
          const set = new Set();
          for (const item of parsed.facts) {
            const clean = String(item).trim();
            if (clean && clean.length < 120) set.add(clean);
          }
          const finalFacts = Array.from(set).slice(-10);
          await redis.set(`contact:${jid}:facts`, JSON.stringify(finalFacts), { ex: CONTACT_TTL_SECONDS });
          logEvent('info', `Saved ${finalFacts.length} permanent facts for ${jid}`);
        }

        // 3. Update contact profile with LLM-detected language
        if (parsed.language && typeof parsed.language === 'string') {
          let prof = { displayName: jid.split('@')[0], preferredLanguage: 'English' };
          if (rawProfile) {
            try { prof = JSON.parse(rawProfile); } catch (_) {}
          }
          prof.preferredLanguage = parsed.language.trim();
          await redis.set(`contact:${jid}:profile`, JSON.stringify(prof), { ex: CONTACT_TTL_SECONDS });
          logEvent('info', `Updated language for ${jid} to ${prof.preferredLanguage}`);
        }
      } else {
        // Fallback: If JSON parse failed, treat entire output as summary text
        const trimmed = res.text.slice(0, 600).trim();
        await redis.set(`sum:${jid}`, trimmed, { ex: CONTACT_TTL_SECONDS });
        logEvent('info', `Updated summary fallback for ${jid} (${trimmed.length} chars)`);
      }
    }
  } catch (err) {
    logEvent('warn', `Rolling summary failed for ${jid}: ${err.message}`);
  }
}

