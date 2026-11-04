import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { recordMessage } from '../memory/store.js';

export const DEFAULT_PACING_SETTINGS = {
  typingDelayEnabled: true,
  typingSpeed: 'normal', // 'fast' | 'normal' | 'slow'
  batchingEnabled: true,
  batchWindowSec: 5, // 2 to 12
  splitRepliesEnabled: true,
  reactionsEnabled: true,
  maxHourlyRepliesPerContact: 30,
  maxHourlyRepliesGlobal: 150
};

// Map of senderJid -> batch object
// {
//   entries: [{ m, cleanText, pushName, timestamp }],
//   firstArrivedAt: number,
//   quietTimer: Timeout,
//   maxTimer: Timeout,
//   generationToken: number,
//   activeTask: boolean
// }
const batchMap = new Map();

/**
 * Remove control markers so recipients never see internal tags
 */
export function sanitizeOutboundText(text) {
  if (!text) return '';
  return text
    .replace(/\[REACT:\s*[^\]]+\]/gi, '')
    .replace(/\[SPLIT\]/gi, '')
    .replace(/\[NO_REPLY\]/gi, '')
    .replace(/\[FOR_OWNER\]/gi, '')
    .replace(/\[UNKNOWN:\s*[^\]]+\]/gi, '')
    .replace(/\[STOP_SCHEDULE\]/gi, '')
    .trim();
}

/**
 * Extract question from [UNKNOWN: question]
 */
export function parseUnknownMarker(text) {
  if (!text) return null;
  const match = text.match(/\[UNKNOWN:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract emoji from [REACT:emoji]
 */
export function parseReactionMarker(text) {
  if (!text) return null;
  const match = text.match(/\[REACT:\s*([^\]]+)\]/i);
  if (!match) return null;
  const rawEmoji = match[1].trim();
  return rawEmoji || null;
}

/**
 * Split text by [SPLIT] marker, clamping to maximum 3 chunks
 */
export function parseSplitChunks(text) {
  if (!text) return [];
  const parts = text.split(/\[SPLIT\]/gi).map(p => sanitizeOutboundText(p)).filter(Boolean);
  if (parts.length <= 3) return parts;
  // If more than 3 parts, merge trailing parts into the 3rd part
  const combinedThird = parts.slice(2).join(' ');
  return [parts[0], parts[1], combinedThird];
}

/**
 * Calculate natural typing delay based on reply length and chosen speed.
 * Clamped strictly between 1.2s and 10s.
 */
export function calculateTypingDelay(textLength, speed = 'normal') {
  let msPerChar = 55;
  let jitterMin = 600;
  let jitterMax = 1400;

  if (speed === 'fast') {
    msPerChar = 30;
    jitterMin = 300;
    jitterMax = 800;
  } else if (speed === 'slow') {
    msPerChar = 85;
    jitterMin = 1000;
    jitterMax = 2200;
  }

  const jitter = Math.floor(Math.random() * (jitterMax - jitterMin + 1)) + jitterMin;
  const calculated = (textLength * msPerChar) + jitter;
  return Math.min(10000, Math.max(1200, calculated));
}

/**
 * Check and enforce hourly rate limits (per-contact and global)
 */
export async function checkHourlyRateLimits(senderJid, pacing) {
  const hourKey = new Date().toISOString().slice(0, 13); // e.g. "2026-11-03T01"
  const globalKey = `ratelimit:global:${hourKey}`;
  const contactKey = `ratelimit:contact:${senderJid}:${hourKey}`;

  const [rawGlobal, rawContact] = await Promise.all([
    redis.get(globalKey),
    redis.get(contactKey)
  ]);

  const globalCount = parseInt(rawGlobal || '0', 10);
  const contactCount = parseInt(rawContact || '0', 10);

  const maxGlobal = pacing.maxHourlyRepliesGlobal || 150;
  const maxContact = pacing.maxHourlyRepliesPerContact || 30;

  if (globalCount >= maxGlobal) {
    state.isGlobalRateLimited = true;
    state.globalRateLimitResetAt = Date.now() + (60 - new Date().getMinutes()) * 60 * 1000;
    logEvent('warn', `Global rate limit reached (${globalCount}/${maxGlobal} replies this hour). Automated replies paused.`);
    return { allowed: false, reason: 'global_limit', count: globalCount, max: maxGlobal };
  }

  // Clear global limit flag if below limit
  if (state.isGlobalRateLimited) {
    state.isGlobalRateLimited = false;
  }

  if (contactCount >= maxContact) {
    logEvent('warn', `Contact rate limit reached for ${senderJid} (${contactCount}/${maxContact} replies this hour). Pausing replies for this contact.`);
    return { allowed: false, reason: 'contact_limit', count: contactCount, max: maxContact };
  }

  return { allowed: true, hourKey };
}

/**
 * Increment hourly counters after sending
 */
export async function incrementHourlyCounters(senderJid, hourKey) {
  if (!hourKey) return;
  try {
    const globalKey = `ratelimit:global:${hourKey}`;
    const contactKey = `ratelimit:contact:${senderJid}:${hourKey}`;

    const [gCount, cCount] = await Promise.all([
      redis.incr(globalKey),
      redis.incr(contactKey)
    ]);

    if (gCount === 1) await redis.expire(globalKey, 3600);
    if (cCount === 1) await redis.expire(contactKey, 3600);
  } catch (err) {
    console.warn('[Pacing] Could not increment rate limit counter:', err.message);
  }
}

/**
 * Check if a reaction can be sent to this contact (max 1 reaction per contact per 15 min)
 */
export async function canSendReaction(senderJid) {
  try {
    const lastReaction = await redis.get(`ratelimit:reaction:${senderJid}`);
    if (lastReaction) {
      const elapsed = Date.now() - parseInt(lastReaction, 10);
      if (elapsed < 15 * 60 * 1000) {
        return false;
      }
    }
    return true;
  } catch (_) {
    return true;
  }
}

/**
 * Record that a reaction was sent
 */
export async function recordReactionSent(senderJid) {
  try {
    await redis.set(`ratelimit:reaction:${senderJid}`, String(Date.now()), { ex: 900 });
  } catch (_) {}
}

/**
 * Cancel any pending message batch for a contact (e.g. if owner manually replies)
 */
export function cancelPendingBatch(senderJid) {
  const batch = batchMap.get(senderJid);
  if (!batch) return;
  if (batch.quietTimer) clearTimeout(batch.quietTimer);
  if (batch.maxTimer) clearTimeout(batch.maxTimer);
  batch.generationToken++;
  batchMap.delete(senderJid);
}

/**
 * Enqueue an incoming message into the contact's batch queue.
 * Combines bursts of messages sent within quiet window (default 5s, 2-12s).
 * Enforces safety max cutoff of 20 seconds.
 * If AI is currently generating and a new message arrives, discards stale generation and re-queues.
 */
export async function enqueueIncomingMessage({ m, senderJid, cleanText, pushName, processBatchCallback }) {
  const settings = await getSettings();
  const pacing = settings.pacing || DEFAULT_PACING_SETTINGS;

  // If batching is turned off, execute immediately
  if (pacing.batchingEnabled === false) {
    await processBatchCallback({
      entries: [{ m, cleanText, pushName, timestamp: Date.now() }],
      token: 1,
      isTokenValid: () => true
    });
    return;
  }

  const quietMs = Math.min(12000, Math.max(2000, (pacing.batchWindowSec || 5) * 1000));
  let batch = batchMap.get(senderJid);

  if (batch) {
    // Contact sent another message in this burst
    batch.entries.push({ m, cleanText, pushName, timestamp: Date.now() });
    
    // Invalidate any in-flight AI generation for this contact
    batch.generationToken++;
    const currentToken = batch.generationToken;

    // Reset the quiet window timer
    if (batch.quietTimer) clearTimeout(batch.quietTimer);

    batch.quietTimer = setTimeout(() => {
      triggerBatchExecution(senderJid, currentToken, processBatchCallback);
    }, quietMs);

  } else {
    // First message of a new burst
    const generationToken = 1;
    const newBatch = {
      entries: [{ m, cleanText, pushName, timestamp: Date.now() }],
      firstArrivedAt: Date.now(),
      generationToken,
      quietTimer: null,
      maxTimer: null
    };

    newBatch.quietTimer = setTimeout(() => {
      triggerBatchExecution(senderJid, generationToken, processBatchCallback);
    }, quietMs);

    // Hard safety cutoff: never wait more than 20 seconds total
    newBatch.maxTimer = setTimeout(() => {
      triggerBatchExecution(senderJid, newBatch.generationToken, processBatchCallback);
    }, 20000);

    batchMap.set(senderJid, newBatch);
  }
}

async function triggerBatchExecution(senderJid, token, processBatchCallback) {
  const batch = batchMap.get(senderJid);
  if (!batch) return;

  if (batch.generationToken !== token) {
    // Newer messages arrived since this timer was set
    return;
  }

  // Clear timers and remove from active batch map
  if (batch.quietTimer) clearTimeout(batch.quietTimer);
  if (batch.maxTimer) clearTimeout(batch.maxTimer);
  const entries = [...batch.entries];
  const currentToken = batch.generationToken;
  batchMap.delete(senderJid);

  const isTokenValid = (checkToken) => {
    // If a new batch started and advanced the token, checkToken is invalid
    const active = batchMap.get(senderJid);
    if (active && active.generationToken > checkToken) return false;
    return checkToken === currentToken;
  };

  try {
    await processBatchCallback({ entries, token: currentToken, isTokenValid });
  } catch (err) {
    console.error(`[Pacing] Batch execution error for ${senderJid}:`, err.message);
  }
}

/**
 * Dispatch an AI reply with natural pacing:
 * - Mark as read & typing simulation
 * - Split replies with inter-message delays
 * - Emoji reactions
 * - Fallback to standard single reply on failure
 */
export async function dispatchPacedReply({
  sock,
  senderJid,
  rawReplyText,
  lastMsg,
  pacing,
  senderLabel,
  hourKey
}) {
  if (!sock) return;

  const rawTrimmed = (rawReplyText || '').trim();

  // 1. Check for silence marker
  if (rawTrimmed === '[NO_REPLY]' || rawTrimmed.includes('[NO_REPLY]')) {
    try { await sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
    logEvent('info', `Model chose silence for ${senderJid} ([NO_REPLY])`);
    return;
  }

  const speed = pacing.typingSpeed || 'normal';
  const lastKey = lastMsg?.key;

  // 2. Check for Reaction marker [REACT:emoji]
  const reactionEmoji = parseReactionMarker(rawTrimmed);
  const cleanedText = sanitizeOutboundText(rawTrimmed);

  if (reactionEmoji) {
    const reactionsAllowed = pacing.reactionsEnabled !== false && await canSendReaction(senderJid);
    if (reactionsAllowed && lastKey) {
      try {
        await sock.sendMessage(senderJid, {
          react: {
            text: reactionEmoji,
            key: lastKey
          }
        });
        await recordReactionSent(senderJid);
        await incrementHourlyCounters(senderJid, hourKey);
        logEvent('info', `Sent reaction ${reactionEmoji} to ${senderJid}`);

        // If no additional text was output, reaction completes the turn
        if (!cleanedText) {
          try { await sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
          return;
        }
      } catch (reactErr) {
        logEvent('warn', `Reaction delivery failed, falling back to text: ${reactErr.message}`);
      }
    } else {
      // Reaction not allowed or rate limited
      if (!cleanedText) {
        // If the model intended only a reaction and it's rate-limited, fall back to silence or no-op
        try { await sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
        logEvent('info', `Reaction rate-limited for ${senderJid}; skipping duplicate reaction.`);
        return;
      }
    }
  }

  if (!cleanedText) {
    try { await sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
    return;
  }

  // 3. Split replies handling
  let chunks = [];
  if (pacing.splitRepliesEnabled !== false && rawTrimmed.includes('[SPLIT]')) {
    chunks = parseSplitChunks(rawTrimmed);
  }

  if (chunks.length === 0) {
    // Single message (or splits disabled: replace [SPLIT] with newline)
    chunks = [cleanedText];
  }

  // 4. Send chunks with natural typing delays
  try {
    // Initial short pause before marking read & typing
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400) + 300));

    // Mark incoming message as read
    if (lastKey) {
      try {
        await sock.readMessages([lastKey]);
      } catch (_) {}
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      if (pacing.typingDelayEnabled !== false) {
        // Show typing indicator
        try {
          await sock.sendPresenceUpdate('composing', senderJid);
        } catch (_) {}

        // Typing time depends on length with random variation, capped at 10s
        const typingDuration = calculateTypingDelay(chunk.length, speed);
        await new Promise(r => setTimeout(r, typingDuration));
      }

      // Stop typing right before sending
      try {
        await sock.sendPresenceUpdate('paused', senderJid);
      } catch (_) {}

      // Send the chunk
      const sent = await sock.sendMessage(senderJid, { text: chunk });
      if (sent?.key?.id) {
        state.botSentMessageIds.add(sent.key.id);
        if (state.botSentMessageIds.size > 2000) {
          const first = state.botSentMessageIds.values().next().value;
          state.botSentMessageIds.delete(first);
        }
      }

      await recordMessage(senderJid, 'assistant', chunk, true, senderLabel);
      await incrementHourlyCounters(senderJid, hourKey);

      // If multiple chunks, pause between messages (1-3s)
      if (i < chunks.length - 1) {
        const pauseBetween = Math.floor(Math.random() * 1500) + 1000;
        await new Promise(r => setTimeout(r, pauseBetween));
      }
    }

    logEvent('info', `Sent paced AI reply (${chunks.length} part${chunks.length > 1 ? 's' : ''}) to ${senderJid}`);

  } catch (deliveryErr) {
    // FALLBACK: if pacing or presence updates fail, fall back to plain single reply
    logEvent('warn', `Pacing error (${deliveryErr.message}), executing plain fallback reply`);
    try {
      const sent = await sock.sendMessage(senderJid, { text: cleanedText });
      if (sent?.key?.id) state.botSentMessageIds.add(sent.key.id);
      await recordMessage(senderJid, 'assistant', cleanedText, true, senderLabel);
      await incrementHourlyCounters(senderJid, hourKey);
    } catch (fallbackErr) {
      logEvent('error', `Fallback reply also failed for ${senderJid}: ${fallbackErr.message}`);
    }
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', senderJid);
    } catch (_) {}
  }
}
