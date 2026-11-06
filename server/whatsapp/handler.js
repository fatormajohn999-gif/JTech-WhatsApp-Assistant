import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { formatLastSeen } from '../brain/prompt-builder.js';
import {
  getChatMemory,
  recordMessage,
  jidToPhone,
  normalizeJid,
  isChatPaused
} from '../memory/store.js';
import {
  generateAiReply,
  buildAlternatingTurns,
  checkAutoPause
} from '../ai/index.js';
import {
  DEFAULT_PACING_SETTINGS,
  cancelPendingBatch,
  enqueueIncomingMessage,
  dispatchPacedReply,
  checkHourlyRateLimits,
  parseUnknownMarker
} from './pacing.js';
import {
  captureOwnerReply,
  getLearnedStyle,
  getLearnedExamples
} from '../memory/owner-style.js';
import { recordTeachMeItem, getKnowledgeForPrompt } from '../memory/knowledge.js';
import { markChatActiveToday } from '../lib/daily-summary.js';
import { pauseSchedulesForContact } from '../lib/scheduler.js';

export function matchesContactRule(jid, list, knownPhone = '') {
  if (!Array.isArray(list) || list.length === 0) return false;
  const cleanJid = (jid || '').toLowerCase().trim();
  const phoneDigits = String(knownPhone || jid.split('@')[0]).replace(/\D/g, '');

  for (const entry of list) {
    if (!entry) continue;
    const cleanEntry = entry.toLowerCase().trim();
    const entryDigits = cleanEntry.replace(/\D/g, '');

    if (cleanJid === cleanEntry) return true;
    if (cleanJid.includes(cleanEntry) || cleanEntry.includes(cleanJid)) return true;

    if (phoneDigits && entryDigits) {
      if (phoneDigits === entryDigits || phoneDigits.endsWith(entryDigits) || entryDigits.endsWith(phoneDigits)) {
        return true;
      }
    }
  }
  return false;
}

export async function handleIncomingMessage(m) {
  if (!m || !m.message) return;

  const rawSenderJid = m.key.remoteJid || '';
  if (!rawSenderJid) return;

  // Skip group chats, broadcasts, newsletters
  if (rawSenderJid.endsWith('@g.us')) return;
  if (rawSenderJid.includes('@broadcast') || rawSenderJid === 'status@broadcast') return;
  if (rawSenderJid.endsWith('@newsletter')) return;

  const senderJid = await normalizeJid(rawSenderJid);
  const msgId = m.key.id;

  // Owner human reply detection (silences bot for 10 minutes and captures reply)
  if (m.key.fromMe) {
    if (state.botSentMessageIds.has(msgId)) return;

    // Cancel any queued batch for this contact since owner stepped in
    cancelPendingBatch(senderJid);

    const silenceUntil = Date.now() + 10 * 60 * 1000;
    await Promise.all([
      redis.set(`handoff:${senderJid}`, String(silenceUntil), { ex: 600 }),
      redis.del(`contact:${senderJid}:needs_owner`)
    ]);
    const metaRaw = await redis.get(`chat:${senderJid}:meta`);
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        meta.needsOwner = false;
        await redis.set(`chat:${senderJid}:meta`, JSON.stringify(meta));
      } catch (_) {}
    }
    logEvent('info', `Owner replied directly to ${senderJid}. Silencing bot for 10 minutes and clearing needsOwner flag.`);

    const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Owner sent media]';
    await recordMessage(senderJid, 'assistant', text, true, 'Owner (You)');

    // Feature 1: Capture what the owner writes (for style learning and learned examples)
    await captureOwnerReply(senderJid, text);
    // Feature 5: Track chat active today
    await markChatActiveToday(senderJid);
    return;
  }

  // Feature 5: Track contact message activity today
  await markChatActiveToday(senderJid);

  // Check Per-Chat Pause status
  const chatPause = await isChatPaused(senderJid);
  if (chatPause.isPaused) {
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
    await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
    logEvent('info', `Chat with ${senderJid} is paused (${chatPause.pauseUntil ? 'until ' + new Date(chatPause.pauseUntil).toISOString() : 'indefinitely'}). Message recorded, bot reply skipped.`);
    return;
  }

  // Check Handoff Status
  const handoffVal = await redis.get(`handoff:${senderJid}`);
  if (handoffVal) {
    const until = parseInt(handoffVal, 10);
    if (!isNaN(until) && Date.now() < until) {
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    } else if (isNaN(until)) {
      // Manual takeover indefinite pause
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '[Media]';
      await recordMessage(senderJid, 'user', text, false, m.pushName || 'Contact');
      return;
    }
  }

  // Contact Rules Check
  const settings = await getSettings();
  const rules = settings.contactRules || { mode: 'all', allowlist: [], blocklist: [] };
  const phone = jidToPhone(senderJid);

  if (rules.mode === 'allowlist') {
    if (!matchesContactRule(senderJid, rules.allowlist, phone)) return;
  } else if (rules.mode === 'blocklist') {
    if (matchesContactRule(senderJid, rules.blocklist, phone)) return;
  }

  const pushName = m.pushName || '';
  const msgContent = m.message;

  let userText = '';
  let isMedia = false;

  if (msgContent.conversation) {
    userText = msgContent.conversation;
  } else if (msgContent.extendedTextMessage?.text) {
    userText = msgContent.extendedTextMessage.text;
  } else if (msgContent.imageMessage) {
    isMedia = true;
    userText = msgContent.imageMessage.caption || '';
  } else if (msgContent.audioMessage) {
    isMedia = true;
  } else if (msgContent.videoMessage) {
    isMedia = true;
    userText = msgContent.videoMessage.caption || '';
  } else if (msgContent.documentMessage) {
    isMedia = true;
  } else if (msgContent.stickerMessage) {
    return;
  }

  // Media note if no accompanying text
  if (isMedia && !userText.trim()) {
    userText = '[the contact sent a voice note or photo you cannot open]';
  }

  if (!userText || !userText.trim()) return;
  const cleanText = userText.trim();

  // Record incoming user message immediately so chat history is preserved
  await recordMessage(senderJid, 'user', cleanText, false, pushName);

  // Enqueue message into batching queue (burst consolidation + quiet window)
  await enqueueIncomingMessage({
    m,
    senderJid,
    cleanText,
    pushName,
    processBatchCallback: async ({ entries, token, isTokenValid }) => {
      // Double check handoff did not activate during batch window
      const currentHandoff = await redis.get(`handoff:${senderJid}`);
      if (currentHandoff) return;

      const livePause = await isChatPaused(senderJid);
      if (livePause.isPaused) return;

      // Check auto-pause and manual pause
      const isAutoPaused = await checkAutoPause();
      if (isAutoPaused) return;

      const liveSettings = await getSettings();
      if (liveSettings.isPaused) return;

      const pacing = liveSettings.pacing || DEFAULT_PACING_SETTINGS;

      // Check hourly safety rate limits
      const rateCheck = await checkHourlyRateLimits(senderJid, pacing);
      if (!rateCheck.allowed) {
        return;
      }

      // Combine messages from burst
      const combinedUserText = entries.map(e => e.cleanText).filter(Boolean).join('\n');
      const lastEntry = entries[entries.length - 1];
      const lastMsg = lastEntry?.m || m;

      // Fetch memory & context
      const memory = await getChatMemory(senderJid);
      const lastSpokeText = formatLastSeen(memory.profile?.lastSeen);

      // Build multi-turn context (last 12 messages with alternating turns)
      const turns = buildAlternatingTurns(memory.messages, combinedUserText);

      if (!state.sock) return;

      // Fetch learning context: learned style, examples, and knowledge base
      let ownerLearnedStyle = null;
      let learnedExamples = [];
      let ownerKnowledge = '';
      try {
        [ownerLearnedStyle, learnedExamples, ownerKnowledge] = await Promise.all([
          getLearnedStyle(senderJid),
          getLearnedExamples(senderJid, 5),
          getKnowledgeForPrompt(senderJid)
        ]);
      } catch (learnErr) {
        console.warn('[Learning] Non-blocking context fetch error:', learnErr.message);
      }

      try {
        const aiResult = await generateAiReply(turns, {
          contactFacts: memory.facts,
          chatSummary: memory.summary,
          senderJid,
          contactName: memory.settings?.displayName || memory.profile?.displayName || pushName || phone,
          contactProfile: memory.profile,
          contactSettings: memory.settings,
          lastSpokeText,
          ownerLearnedStyle,
          learnedExamples,
          ownerKnowledge
        });

        // Discard stale in-flight AI generation if new messages arrived in the meantime
        if (!isTokenValid(token)) {
          logEvent('info', `Discarded stale reply for ${senderJid} because newer messages arrived.`);
          return;
        }

        if (aiResult.paused) {
          try { await state.sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
          return;
        }

        if (aiResult.text) {
          const trimmedText = aiResult.text.trim();

          // Feature 3: Check for [UNKNOWN: question] marker
          const unknownQuestion = parseUnknownMarker(trimmedText);
          if (unknownQuestion) {
            const contactDisplayName = memory.settings?.displayName || memory.profile?.displayName || pushName || phone || senderJid;
            await recordTeachMeItem({
              contactJid: senderJid,
              contactName: contactDisplayName,
              originalMessage: combinedUserText,
              question: unknownQuestion
            });
          }

          // Check for [STOP_SCHEDULE] request marker
          if (trimmedText.includes('[STOP_SCHEDULE]')) {
            await pauseSchedulesForContact(senderJid, 'Recipient asked to stop messaging');
            const metaRaw = await redis.get(`chat:${senderJid}:meta`);
            if (metaRaw) {
              try {
                const meta = JSON.parse(metaRaw);
                meta.needsOwner = true;
                await redis.set(`chat:${senderJid}:meta`, JSON.stringify(meta));
              } catch (_) {}
            }
            await redis.set(`contact:${senderJid}:needs_owner`, 'true');
            logEvent('warn', `Contact ${senderJid} asked to stop messaging ([STOP_SCHEDULE] detected). Schedules paused and flagged "Needs Owner".`);

            if (liveSettings.notifyOwnerOnWhatsApp && state.activePhone) {
              const ownerJid = `${state.activePhone}@s.whatsapp.net`;
              if (ownerJid !== senderJid) {
                try {
                  const contactDisplayName = memory.settings?.displayName || memory.profile?.displayName || pushName || phone || senderJid;
                  const alertMsg = `🛑 [Unsubscribe Alert] ${contactDisplayName} asked to stop receiving messages. Their schedules have been paused automatically.`;
                  const alertSent = await state.sock.sendMessage(ownerJid, { text: alertMsg });
                  if (alertSent?.key?.id) state.botSentMessageIds.add(alertSent.key.id);
                } catch (_) {}
              }
            }
          }

          // Check for [FOR_OWNER] escalation marker
          const needsOwnerEscalation = trimmedText.includes('[FOR_OWNER]');

          if (needsOwnerEscalation) {
            const metaRaw = await redis.get(`chat:${senderJid}:meta`);
            if (metaRaw) {
              try {
                const meta = JSON.parse(metaRaw);
                meta.needsOwner = true;
                await redis.set(`chat:${senderJid}:meta`, JSON.stringify(meta));
              } catch (_) {}
            }
            await redis.set(`contact:${senderJid}:needs_owner`, 'true');
            logEvent('info', `Marked conversation with ${senderJid} as "Needs Owner" ([FOR_OWNER] detected).`);

            if (liveSettings.notifyOwnerOnWhatsApp && state.activePhone) {
              const ownerJid = `${state.activePhone}@s.whatsapp.net`;
              if (ownerJid !== senderJid) {
                try {
                  const contactDisplayName = memory.settings?.displayName || memory.profile?.displayName || pushName || phone || senderJid;
                  const alertMsg = `⚠️ [Alert] ${contactDisplayName} needs your attention on WhatsApp: "${combinedUserText.slice(0, 80)}"`;
                  const alertSent = await state.sock.sendMessage(ownerJid, { text: alertMsg });
                  if (alertSent?.key?.id) {
                    state.botSentMessageIds.add(alertSent.key.id);
                  }
                  logEvent('info', `Sent WhatsApp alert to owner (${ownerJid}) for ${senderJid}`);
                } catch (notifyErr) {
                  logEvent('warn', `Failed to send WhatsApp alert to owner: ${notifyErr.message}`);
                }
              }
            }
          }

          // Dispatch with pacing (typing simulation, splits, reactions, rate limits)
          const senderLabel = liveSettings.profile?.ownerName ? `${liveSettings.profile.ownerName} (AI)` : 'You';
          await dispatchPacedReply({
            sock: state.sock,
            senderJid,
            rawReplyText: trimmedText,
            lastMsg,
            pacing,
            senderLabel,
            hourKey: rateCheck.hourKey
          });
        }

      } catch (err) {
        if (state.sock) {
          try { await state.sock.sendPresenceUpdate('paused', senderJid); } catch (_) {}
        }
        logEvent('error', `Error answering ${senderJid}: ${err.message}`);
        try {
          await redis.set(`contact:${senderJid}:needs_owner`, 'true');
          const metaRaw = await redis.get(`chat:${senderJid}:meta`);
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            meta.needsOwner = true;
            await redis.set(`chat:${senderJid}:meta`, JSON.stringify(meta));
          }
        } catch (_) {}
      }
    }
  });
}

