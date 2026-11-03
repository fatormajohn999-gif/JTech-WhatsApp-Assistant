import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { getChatMemory } from './store.js';
import { runAiCompletion } from '../ai/index.js';

let isAnalyzingStyle = false;

/**
 * Capture an owner reply typed directly from their WhatsApp device.
 * Stores up to 30 pairs per contact and 100 globally.
 * Triggers background style learning every ~15 owner messages.
 */
export async function captureOwnerReply(senderJid, ownerText) {
  if (!senderJid || !ownerText) return;
  const cleanOwnerText = ownerText.trim();
  if (!cleanOwnerText || cleanOwnerText.startsWith('[')) return;

  try {
    const settings = await getSettings();
    if (settings.learnFromReplies === false) return;

    // Find the last message sent by the contact that this answers
    const memory = await getChatMemory(senderJid);
    const messages = memory.messages || [];
    let lastContactMsg = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].fromMe && messages[i].role === 'user') {
        lastContactMsg = messages[i];
        break;
      }
    }

    const contactText = lastContactMsg?.text ? lastContactMsg.text.trim() : '';

    const pair = {
      id: `or_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      contactJid: senderJid,
      contactMessage: contactText,
      ownerReply: cleanOwnerText,
      timestamp: Date.now()
    };

    const serialized = JSON.stringify(pair);

    // Save per-contact (last 30)
    await redis.lpush(`owner:replies:${senderJid}`, serialized);
    await redis.ltrim(`owner:replies:${senderJid}`, 0, 29);

    // Save global (last 100)
    await redis.lpush('owner:replies:global', serialized);
    await redis.ltrim('owner:replies:global', 0, 99);

    // Count owner messages
    const count = await redis.incr('stats:owner_messages_count');

    // Every 15 messages, trigger background style learning
    if (count % 15 === 0) {
      setTimeout(() => {
        analyzeOwnerStyle(senderJid).catch(err => {
          logEvent('warn', `Background style learning error: ${err.message}`);
        });
      }, 1000);
    }
  } catch (err) {
    console.warn('[OwnerStyle] Could not capture reply:', err.message);
  }
}

/**
 * Analyzes the owner's texting style based on captured examples.
 * Produces global style and, if enough data, per-contact style.
 */
export async function analyzeOwnerStyle(specificJid = null) {
  if (isAnalyzingStyle) return;
  isAnalyzingStyle = true;

  try {
    // 1. Analyze Global Style from last 30 pairs
    const globalRaw = await redis.lrange('owner:replies:global', 0, 29);
    if (globalRaw && globalRaw.length >= 5) {
      const parsedPairs = [];
      for (const item of globalRaw) {
        try { parsedPairs.push(JSON.parse(item)); } catch (_) {}
      }

      if (parsedPairs.length >= 5) {
        const samplesText = parsedPairs
          .map((p, idx) => `Example ${idx + 1}:\nContact: "${p.contactMessage || '(started conversation)'}"\nOwner: "${p.ownerReply}"`)
          .join('\n\n');

        const prompt = `
Analyze these real message pairs sent by the owner on WhatsApp:

${samplesText}

Write a concise description (3-5 short sentences) of how the owner texts:
- Typical message length and conciseness
- Capitalization, punctuation, and emoji use
- Slang, Krio / English mix, and casual phrasing
- Common greetings and sign-offs
Write directly as instructions for how to mimic this texting voice. Do NOT include markdown headers or greetings.
`.trim();

        const styleDescription = await runAiCompletion(prompt, 'You are an expert linguistic analyst profiling a person\'s texting style.');
        if (styleDescription && styleDescription.trim()) {
          await redis.set('owner:style:global', styleDescription.trim());
          logEvent('info', 'Updated learned owner texting style from recent replies.');
        }
      }
    }

    // 2. Analyze specific contact style if >= 5 messages exist
    if (specificJid) {
      const contactRaw = await redis.lrange(`owner:replies:${specificJid}`, 0, 24);
      if (contactRaw && contactRaw.length >= 5) {
        const contactPairs = [];
        for (const item of contactRaw) {
          try { contactPairs.push(JSON.parse(item)); } catch (_) {}
        }

        if (contactPairs.length >= 5) {
          const contactSamples = contactPairs
            .map((p, idx) => `Contact: "${p.contactMessage || ''}" -> Owner: "${p.ownerReply}"`)
            .join('\n');

          const prompt = `
Based on these texts between the owner and this specific contact:
${contactSamples}

Describe in 1 to 2 short sentences how the owner texts this specific person (tone, formality, inside jokes, or language).
`.trim();

          const contactStyle = await runAiCompletion(prompt, 'You analyze interpersonal communication style.');
          if (contactStyle && contactStyle.trim()) {
            await redis.set(`owner:style:${specificJid}`, contactStyle.trim());
          }
        }
      }
    }
  } catch (err) {
    logEvent('warn', `Style analysis encountered an error: ${err.message}`);
  } finally {
    isAnalyzingStyle = false;
  }
}

/**
 * Get learned style descriptions for prompt injection
 */
export async function getLearnedStyle(senderJid = '') {
  try {
    const [globalStyle, contactStyle] = await Promise.all([
      redis.get('owner:style:global'),
      senderJid ? redis.get(`owner:style:${senderJid}`) : null
    ]);

    return {
      globalStyle: globalStyle || '',
      contactStyle: contactStyle || ''
    };
  } catch (_) {
    return { globalStyle: '', contactStyle: '' };
  }
}

/**
 * Get 3 to 5 most relevant recent examples for contact (or global if none for contact)
 */
export async function getLearnedExamples(senderJid, limit = 5) {
  try {
    let rawItems = [];
    if (senderJid) {
      rawItems = await redis.lrange(`owner:replies:${senderJid}`, 0, limit - 1);
    }

    // If fewer than 3 for this contact, fetch global to supplement
    if (rawItems.length < 3) {
      const globalItems = await redis.lrange('owner:replies:global', 0, limit - 1);
      const existingIds = new Set(rawItems.map(r => {
        try { return JSON.parse(r).id; } catch (_) { return ''; }
      }));

      for (const gi of globalItems) {
        try {
          const parsed = JSON.parse(gi);
          if (!existingIds.has(parsed.id)) {
            rawItems.push(gi);
            if (rawItems.length >= limit) break;
          }
        } catch (_) {}
      }
    }

    const examples = [];
    for (const item of rawItems) {
      try {
        examples.push(JSON.parse(item));
      } catch (_) {}
    }
    return examples.slice(0, limit);
  } catch (_) {
    return [];
  }
}

/**
 * Delete a specific learned example from contact list and global list
 */
export async function deleteLearnedExample(senderJid, id) {
  if (!id) return;
  try {
    if (senderJid) {
      const rawList = await redis.lrange(`owner:replies:${senderJid}`, 0, 50);
      const filtered = rawList.filter(item => {
        try { return JSON.parse(item).id !== id; } catch (_) { return true; }
      });
      await redis.del(`owner:replies:${senderJid}`);
      if (filtered.length > 0) {
        // rpush in reverse order to keep order
        await redis.rpush(`owner:replies:${senderJid}`, ...filtered);
      }
    }

    const globalList = await redis.lrange('owner:replies:global', 0, 100);
    const filteredGlobal = globalList.filter(item => {
      try { return JSON.parse(item).id !== id; } catch (_) { return true; }
    });
    await redis.del('owner:replies:global');
    if (filteredGlobal.length > 0) {
      await redis.rpush('owner:replies:global', ...filteredGlobal);
    }
    logEvent('info', `Deleted learned example ${id}`);
  } catch (err) {
    console.warn('[OwnerStyle] Could not delete example:', err.message);
  }
}

/**
 * Clear all learned reply data and style summaries
 */
export async function clearAllLearnedData() {
  try {
    await redis.del('owner:style:global');
    await redis.del('owner:replies:global');
    await redis.del('stats:owner_messages_count');

    // Clean keys with prefix
    const contactReplyKeys = await redis.keys('owner:replies:*');
    if (contactReplyKeys && contactReplyKeys.length > 0) {
      await Promise.all(contactReplyKeys.map(k => redis.del(k)));
    }
    const contactStyleKeys = await redis.keys('owner:style:*');
    if (contactStyleKeys && contactStyleKeys.length > 0) {
      await Promise.all(contactStyleKeys.map(k => redis.del(k)));
    }

    logEvent('info', 'All learned reply examples and style data cleared.');
  } catch (err) {
    console.warn('[OwnerStyle] Error clearing learned data:', err.message);
  }
}

/**
 * Reset learned style summaries while keeping reply history
 */
export async function resetLearnedStyle() {
  try {
    await redis.del('owner:style:global');
    const contactStyleKeys = await redis.keys('owner:style:*');
    if (contactStyleKeys && contactStyleKeys.length > 0) {
      await Promise.all(contactStyleKeys.map(k => redis.del(k)));
    }
    logEvent('info', 'Learned style profile reset.');
  } catch (err) {
    console.warn('[OwnerStyle] Error resetting style:', err.message);
  }
}
