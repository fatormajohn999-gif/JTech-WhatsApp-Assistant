import { redis } from './redis.js';
import { logEvent } from './logger.js';
import { state } from '../state.js';
import { getSettings } from './settings.js';
import { runAiCompletion } from '../ai/index.js';
import { getChatMemory } from '../memory/store.js';
import { getPendingTeachMe } from '../memory/knowledge.js';

let summaryTimer = null;

export function getTodayDateStringFreetown() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Freetown' }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

export function getCurrentFreetownHourMinute() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Freetown',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());

    const hour = parts.find(p => p.type === 'hour')?.value || '00';
    const minute = parts.find(p => p.type === 'minute')?.value || '00';
    return `${hour}:${minute}`;
  } catch (_) {
    const d = new Date();
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Record that a contact was active today
 */
export async function markChatActiveToday(senderJid) {
  if (!senderJid) return;
  try {
    const today = getTodayDateStringFreetown();
    await Promise.all([
      redis.sadd(`daily:active_chats:${today}`, senderJid),
      redis.incr(`daily:chat_count:${today}:${senderJid}`)
    ]);
  } catch (_) {}
}

/**
 * Generate and send the daily summary
 */
export async function sendDailySummary(targetDateStr = null, isManualTest = false) {
  const dateStr = targetDateStr || getTodayDateStringFreetown();
  const settings = await getSettings();

  const ownerName = settings.profile?.ownerName || 'JTech';
  const ownerFirstName = settings.profile?.ownerFirstName || ownerName;

  try {
    // 1. Gather active chats today
    const activeJids = await redis.smembers(`daily:active_chats:${dateStr}`);
    const teachMePending = await getPendingTeachMe();

    if ((!activeJids || activeJids.length === 0) && teachMePending.length === 0 && !isManualTest) {
      logEvent('info', `No chat activity for ${dateStr}; skipping daily summary.`);
      return { skipped: true, reason: 'No activity today' };
    }

    const chatSummaries = [];
    const needsOwnerList = [];
    let totalMessagesToday = 0;

    for (const jid of (activeJids || [])) {
      try {
        const [countRaw, memory, isNeedsOwnerRaw] = await Promise.all([
          redis.get(`daily:chat_count:${dateStr}:${jid}`),
          getChatMemory(jid),
          redis.get(`contact:${jid}:needs_owner`)
        ]);

        const count = parseInt(countRaw || '1', 10);
        totalMessagesToday += count;

        const displayName = memory.settings?.displayName || memory.profile?.displayName || jid.split('@')[0];
        const isNeedsOwner = isNeedsOwnerRaw === 'true' || Boolean(memory.profile?.needsOwner);

        if (isNeedsOwner) {
          needsOwnerList.push(displayName);
        }

        const recentTexts = (memory.messages || []).slice(-3).map(m => `${m.role === 'assistant' ? 'AI' : 'Contact'}: "${m.text.slice(0, 60)}"`).join('; ');

        chatSummaries.push({
          displayName,
          count,
          isNeedsOwner,
          recent: recentTexts
        });
      } catch (_) {}
    }

    if (chatSummaries.length === 0 && teachMePending.length === 0 && !isManualTest) {
      return { skipped: true, reason: 'No activity recorded' };
    }

    const chatsContext = chatSummaries.map(c => 
      `- ${c.displayName}: ${c.count} msg(s)${c.isNeedsOwner ? ' [NEEDS OWNER ATTENTION]' : ''}. Recent snippets: ${c.recent || 'N/A'}`
    ).join('\n');

    const teachMeContext = teachMePending.length > 0
      ? teachMePending.map(t => `- From ${t.contactName}: "${t.question}"`).join('\n')
      : 'None';

    const prompt = `
You are the personal assistant for ${ownerName} (referred to as ${ownerFirstName}).
Write a friendly, concise daily briefing message to be sent to ${ownerFirstName}'s WhatsApp about today's activity (${dateStr}).

=== TODAY'S DATA ===
Total Active Conversations: ${chatSummaries.length}
Total Incoming/Outgoing Messages: ${totalMessagesToday}
Contacts Requiring Owner Attention: ${needsOwnerList.length > 0 ? needsOwnerList.join(', ') : 'None'}
Pending Teach-Me Questions: ${teachMePending.length}
Teach-Me Items:
${teachMeContext}

Chat Details:
${chatsContext || 'No conversation activity'}

=== INSTRUCTIONS ===
- Format cleanly for WhatsApp texting using *bold* titles where appropriate.
- Start with a warm evening greeting to ${ownerFirstName}.
- Give a quick 1-sentence overview of today's message traffic.
- If anyone needs the owner, clearly highlight: "⚠️ Needs ${ownerFirstName}: [names]".
- If there are Teach-Me questions waiting, mention how many and briefly what they are asking about.
- Give a brief, friendly 1-line note per important chat.
- Keep the overall briefing concise and scannable (under 200 words).
- Do NOT use markdown headers (# or ##) or emojis excessively.
`.trim();

    const summaryText = await runAiCompletion(prompt, 'You are an executive assistant preparing an evening WhatsApp briefing.');

    if (summaryText && summaryText.trim()) {
      const cleanSummary = summaryText.trim();

      // Store as latest summary for the dashboard
      await redis.set('summary:latest', JSON.stringify({
        date: dateStr,
        text: cleanSummary,
        generatedAt: Date.now()
      }));

      // Send to owner's WhatsApp if socket is connected and phone is known
      if (state.sock && state.activePhone) {
        const ownerJid = `${state.activePhone}@s.whatsapp.net`;
        try {
          const sent = await state.sock.sendMessage(ownerJid, { text: cleanSummary });
          if (sent?.key?.id) {
            state.botSentMessageIds.add(sent.key.id);
          }
          logEvent('info', `Sent daily summary WhatsApp message to owner (${ownerJid}).`);
        } catch (waErr) {
          logEvent('warn', `Failed to send summary to owner WhatsApp: ${waErr.message}`);
        }
      }

      // Mark as sent for today if not a manual test
      if (!isManualTest) {
        await redis.set(`summary:sent:${dateStr}`, 'true', { ex: 172800 });
      }

      return { success: true, text: cleanSummary };
    }

    return { skipped: true, reason: 'AI did not produce summary text' };
  } catch (err) {
    logEvent('error', `Daily summary error: ${err.message}`);
    throw err;
  }
}

/**
 * Check if daily summary is due (runs every minute)
 */
export async function checkDailySummaryDue() {
  try {
    const settings = await getSettings();
    if (settings.dailySummaryEnabled === false) return;

    const todayStr = getTodayDateStringFreetown();
    const alreadySent = await redis.get(`summary:sent:${todayStr}`);
    if (alreadySent) return;

    const currentTime = getCurrentFreetownHourMinute();
    const scheduledTime = settings.dailySummaryTime || '21:00';

    // If current time >= scheduled time (e.g. 21:00 or later, but before midnight)
    if (currentTime >= scheduledTime && currentTime <= '23:59') {
      logEvent('info', `Daily summary is due for ${todayStr} (scheduled ${scheduledTime}, current ${currentTime}). Sending...`);
      await sendDailySummary(todayStr, false);
    }
  } catch (err) {
    console.warn('[DailySummary] Due check error:', err.message);
  }
}

/**
 * Start recurring 60-second timer
 */
export function initDailySummaryScheduler() {
  if (summaryTimer) clearInterval(summaryTimer);
  // Check once immediately on startup
  checkDailySummaryDue().catch(() => {});
  // Check every 60 seconds
  summaryTimer = setInterval(() => {
    checkDailySummaryDue().catch(() => {});
  }, 60000);
}
