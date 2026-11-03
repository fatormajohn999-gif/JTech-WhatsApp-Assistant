import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { formatLastSeen } from '../brain/prompt-builder.js';
import {
  getChatMemory,
  recordMessage,
  jidToPhone
} from '../memory/store.js';
import {
  generateAiReply,
  buildAlternatingTurns
} from '../ai/index.js';

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

  const senderJid = m.key.remoteJid || '';
  if (!senderJid) return;

  // Skip group chats, broadcasts, newsletters
  if (senderJid.endsWith('@g.us')) return;
  if (senderJid.includes('@broadcast') || senderJid === 'status@broadcast') return;
  if (senderJid.endsWith('@newsletter')) return;

  const msgId = m.key.id;

  // Owner human reply detection (silences bot for 10 minutes)
  if (m.key.fromMe) {
    if (state.botSentMessageIds.has(msgId)) return;

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

  // Fetch memory & context
  const memory = await getChatMemory(senderJid);

  const lastSpokeText = formatLastSeen(memory.profile?.lastSeen);

  // Record incoming user message
  await recordMessage(senderJid, 'user', cleanText, false, pushName);

  // Build multi-turn context (last 12 messages with alternating turns)
  const fullConversation = [...memory.messages, { role: 'user', text: cleanText, fromMe: false }];
  const turns = buildAlternatingTurns(fullConversation, cleanText);

  if (!state.sock) return;

  await state.sock.sendPresenceUpdate('composing', senderJid);

  try {
    const aiResult = await generateAiReply(turns, {
      contactFacts: memory.facts,
      chatSummary: memory.summary,
      senderJid,
      contactName: memory.settings?.displayName || memory.profile?.displayName || pushName || phone,
      contactProfile: memory.profile,
      contactSettings: memory.settings,
      lastSpokeText
    });

    if (aiResult.paused) {
      await state.sock.sendPresenceUpdate('paused', senderJid);
      return;
    }

    if (aiResult.text) {
      const trimmedText = aiResult.text.trim();

      // Check for [NO_REPLY] silence signal
      if (trimmedText === '[NO_REPLY]' || trimmedText.includes('[NO_REPLY]')) {
        await state.sock.sendPresenceUpdate('paused', senderJid);
        logEvent('info', `Model chose silence for ${senderJid} ([NO_REPLY])`);
        return;
      }

      // Check for [FOR_OWNER] escalation marker
      const needsOwnerEscalation = trimmedText.includes('[FOR_OWNER]');
      const cleanedReplyText = trimmedText.replace(/\[FOR_OWNER\]/gi, '').trim();

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

        if (settings.notifyOwnerOnWhatsApp && state.activePhone) {
          const ownerJid = `${state.activePhone}@s.whatsapp.net`;
          if (ownerJid !== senderJid) {
            try {
              const contactDisplayName = memory.settings?.displayName || memory.profile?.displayName || pushName || phone || senderJid;
              const alertMsg = `⚠️ [Alert] ${contactDisplayName} needs your attention on WhatsApp: "${cleanText.slice(0, 80)}"`;
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

      if (!cleanedReplyText) {
        await state.sock.sendPresenceUpdate('paused', senderJid);
        return;
      }

      const minD = Math.max(100, settings.minDelay);
      const maxD = Math.max(minD, settings.maxDelay);
      const delay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
      await new Promise(r => setTimeout(r, delay));

      await state.sock.sendPresenceUpdate('paused', senderJid);

      // Send reply without quoting the previous message
      const sent = await state.sock.sendMessage(senderJid, { text: cleanedReplyText });
      if (sent?.key?.id) {
        state.botSentMessageIds.add(sent.key.id);
        if (state.botSentMessageIds.size > 2000) {
          const first = state.botSentMessageIds.values().next().value;
          state.botSentMessageIds.delete(first);
        }
      }

      const senderLabel = settings.profile?.ownerName ? `${settings.profile.ownerName} (AI)` : 'You';
      await recordMessage(senderJid, 'assistant', cleanedReplyText, true, senderLabel);
      logEvent('info', `Sent AI reply to ${senderJid} via ${aiResult.provider} (${delay}ms delay)`);
    }

  } catch (err) {
    if (state.sock) {
      await state.sock.sendPresenceUpdate('paused', senderJid);
    }
    logEvent('error', `Error answering ${senderJid}: ${err.message}`);
  }
}
