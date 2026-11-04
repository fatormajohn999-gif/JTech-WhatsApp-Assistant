import { redis } from './redis.js';
import { logEvent } from './logger.js';
import { state } from '../state.js';
import { getSettings } from './settings.js';
import { runAiCompletion } from '../ai/index.js';
import { getChatMemory, getResolvedContactName, recordMessage, isChatPaused } from '../memory/store.js';
import { getLearnedStyle } from '../memory/owner-style.js';
import { sanitizeOutboundText, parseSplitChunks, calculateTypingDelay } from '../whatsapp/pacing.js';
import { matchesContactRule } from '../whatsapp/handler.js';

let schedulerInterval = null;

// Helper: parse "HH:mm" in Africa/Freetown (UTC+0) and return next timestamp
export function computeNextRun({
  repeat = 'once',
  repeatConfig = {},
  now = Date.now(),
  lastRunAt = null
}) {
  const {
    onceDateTime,
    delayAmount = 1,
    delayUnit = 'hours',
    timeOfDay = '08:00',
    weekdays = [1, 2, 3, 4, 5],
    intervalDays = 1
  } = repeatConfig;

  if (repeat === 'once') {
    if (!onceDateTime) return null;
    const ts = new Date(onceDateTime).getTime();
    return isNaN(ts) ? null : ts;
  }

  if (repeat === 'delay') {
    const mult = delayUnit === 'days' ? 86400000 : 3600000;
    const base = lastRunAt || now;
    return base + (Math.max(1, Number(delayAmount) || 1) * mult);
  }

  // Parse time of day (Africa/Freetown is UTC+0)
  const [hStr, mStr] = (timeOfDay || '08:00').split(':');
  const targetHour = parseInt(hStr || '8', 10);
  const targetMin = parseInt(mStr || '0', 10);

  const nowDate = new Date(now);

  if (repeat === 'daily') {
    const cand = new Date(Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate(),
      targetHour,
      targetMin,
      0, 0
    ));
    if (cand.getTime() <= now) {
      cand.setUTCDate(cand.getUTCDate() + 1);
    }
    return cand.getTime();
  }

  if (repeat === 'weekdays') {
    const daysArr = Array.isArray(weekdays) && weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5];
    for (let offset = 0; offset <= 7; offset++) {
      const cand = new Date(Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate() + offset,
        targetHour,
        targetMin,
        0, 0
      ));
      const candDay = cand.getUTCDay();
      if (daysArr.includes(candDay)) {
        if (cand.getTime() > now) {
          return cand.getTime();
        }
      }
    }
    // Fallback: 7 days later
    return now + 7 * 86400000;
  }

  if (repeat === 'interval') {
    const days = Math.max(1, parseInt(intervalDays || '1', 10));
    if (lastRunAt) {
      const cand = new Date(lastRunAt);
      cand.setUTCDate(cand.getUTCDate() + days);
      cand.setUTCHours(targetHour, targetMin, 0, 0);
      return cand.getTime();
    } else {
      const cand = new Date(Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate(),
        targetHour,
        targetMin,
        0, 0
      ));
      if (cand.getTime() <= now) {
        cand.setUTCDate(cand.getUTCDate() + days);
      }
      return cand.getTime();
    }
  }

  return null;
}

// Check if a timestamp falls inside quiet hours (default 22:00 to 07:00 Africa/Freetown)
export function isInQuietHours(now = Date.now(), startStr = '22:00', endStr = '07:00') {
  const d = new Date(now);
  const curMins = d.getUTCHours() * 60 + d.getUTCMinutes();

  const [sH, sM] = (startStr || '22:00').split(':').map(Number);
  const [eH, eM] = (endStr || '07:00').split(':').map(Number);
  const startMins = sH * 60 + sM;
  const endMins = eH * 60 + eM;

  if (startMins < endMins) {
    return curMins >= startMins && curMins < endMins;
  } else {
    // Overnight: e.g. 22:00 to 07:00
    return curMins >= startMins || curMins < endMins;
  }
}

// Compute the timestamp when current quiet hours end
export function getQuietHoursEndTimestamp(now = Date.now(), endStr = '07:00') {
  const d = new Date(now);
  const [eH, eM] = (endStr || '07:00').split(':').map(Number);
  const endToday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), eH, eM, 0, 0));
  if (endToday.getTime() <= now) {
    endToday.setUTCDate(endToday.getUTCDate() + 1);
  }
  return endToday.getTime();
}

/**
 * Record a scheduler execution log in Redis
 */
export async function recordScheduleHistory(entry) {
  try {
    const item = {
      id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      ...entry
    };
    await redis.lpush('schedules:history', JSON.stringify(item));
    await redis.ltrim('schedules:history', 0, 99);
  } catch (err) {
    console.warn('[Scheduler] History record error:', err.message);
  }
}

/**
 * Create a new schedule
 */
export async function createSchedule(data) {
  const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();

  const contactName = data.contactName || await getResolvedContactName(data.contactJid);

  const schedule = {
    id,
    contactJid: data.contactJid,
    contactName,
    purpose: data.purpose || '',
    mode: data.mode === 'exact' ? 'exact' : 'ai',
    exactText: data.exactText || '',
    repeat: data.repeat || 'once',
    repeatConfig: data.repeatConfig || {},
    messagesPerSend: Math.min(3, Math.max(1, parseInt(data.messagesPerSend || '1', 10))),
    askMeFirst: Boolean(data.askMeFirst),
    sendEvenInQuietHours: Boolean(data.sendEvenInQuietHours),
    endType: data.endType || 'never',
    endDate: data.endDate || null,
    maxSends: data.maxSends ? parseInt(data.maxSends, 10) : null,
    sendCount: 0,
    status: 'active',
    nextRunAt: computeNextRun({
      repeat: data.repeat || 'once',
      repeatConfig: data.repeatConfig || {},
      now
    }),
    lastRunAt: null,
    lastMessageText: null,
    pendingMessageText: null,
    pendingGeneratedAt: null,
    pastSentSummaries: [],
    createdAt: now,
    updatedAt: now,
    retryCount: 0
  };

  // If nextRunAt cannot be computed or is in the past for 'once'
  if (!schedule.nextRunAt) {
    throw new Error('Invalid schedule time or pattern');
  }

  await Promise.all([
    redis.set(`schedule:${id}`, JSON.stringify(schedule)),
    redis.sadd('schedules:all', id),
    redis.sadd(`schedules:contact:${schedule.contactJid}`, id)
  ]);

  logEvent('info', `Created scheduled message [${id}] for ${contactName || schedule.contactJid} (Next run: ${new Date(schedule.nextRunAt).toISOString()})`);
  return schedule;
}

/**
 * Get schedule by ID
 */
export async function getSchedule(id) {
  const raw = await redis.get(`schedule:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Update schedule
 */
export async function updateSchedule(id, updates) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');

  const now = Date.now();
  const repeatChanged = updates.repeat && updates.repeat !== schedule.repeat;
  const configChanged = updates.repeatConfig && JSON.stringify(updates.repeatConfig) !== JSON.stringify(schedule.repeatConfig);

  const updated = {
    ...schedule,
    ...updates,
    id, // protect id
    contactJid: schedule.contactJid, // protect contact
    updatedAt: now
  };

  if (repeatChanged || configChanged || !updated.nextRunAt) {
    updated.nextRunAt = computeNextRun({
      repeat: updated.repeat,
      repeatConfig: updated.repeatConfig,
      now,
      lastRunAt: updated.lastRunAt
    });
  }

  await redis.set(`schedule:${id}`, JSON.stringify(updated));
  logEvent('info', `Updated schedule [${id}] for ${schedule.contactName || schedule.contactJid}`);
  return updated;
}

/**
 * Delete schedule
 */
export async function deleteSchedule(id) {
  const schedule = await getSchedule(id);
  if (schedule) {
    await Promise.all([
      redis.del(`schedule:${id}`),
      redis.srem('schedules:all', id),
      redis.srem(`schedules:contact:${schedule.contactJid}`, id)
    ]);
    logEvent('info', `Deleted schedule [${id}]`);
    return true;
  }
  return false;
}

/**
 * List all schedules
 */
export async function listAllSchedules() {
  const ids = await redis.smembers('schedules:all');
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const pipe = ids.map(id => redis.get(`schedule:${id}`));
  const rawList = await Promise.all(pipe);

  const schedules = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    if (raw) {
      try {
        schedules.push(JSON.parse(raw));
      } catch (_) {}
    } else {
      // Clean up orphaned ID
      await redis.srem('schedules:all', ids[i]);
    }
  }

  schedules.sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
  return schedules;
}

/**
 * List schedules for specific contact
 */
export async function listContactSchedules(jid) {
  const ids = await redis.smembers(`schedules:contact:${jid}`);
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const pipe = ids.map(id => redis.get(`schedule:${id}`));
  const rawList = await Promise.all(pipe);

  const schedules = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    if (raw) {
      try {
        schedules.push(JSON.parse(raw));
      } catch (_) {}
    } else {
      await redis.srem(`schedules:contact:${jid}`, ids[i]);
    }
  }

  schedules.sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
  return schedules;
}

/**
 * Pause schedule
 */
export async function pauseSchedule(id) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');
  schedule.status = 'paused';
  schedule.updatedAt = Date.now();
  await redis.set(`schedule:${id}`, JSON.stringify(schedule));
  logEvent('info', `Paused schedule [${id}]`);
  return schedule;
}

/**
 * Resume schedule
 */
export async function resumeSchedule(id) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');
  const now = Date.now();
  schedule.status = 'active';
  schedule.updatedAt = now;
  // If next run was in the past, recalculate fresh next run
  if (!schedule.nextRunAt || schedule.nextRunAt <= now) {
    schedule.nextRunAt = computeNextRun({
      repeat: schedule.repeat,
      repeatConfig: schedule.repeatConfig,
      now,
      lastRunAt: schedule.lastRunAt
    });
  }
  await redis.set(`schedule:${id}`, JSON.stringify(schedule));
  logEvent('info', `Resumed schedule [${id}] (Next run: ${new Date(schedule.nextRunAt).toISOString()})`);
  return schedule;
}

/**
 * Pause all schedules for a contact (e.g. when contact says "stop messaging me")
 */
export async function pauseSchedulesForContact(jid, reason = 'Recipient asked to stop messaging') {
  const schedules = await listContactSchedules(jid);
  let count = 0;
  for (const s of schedules) {
    if (s.status === 'active' || s.status === 'pending_approval') {
      s.status = 'paused';
      s.updatedAt = Date.now();
      await redis.set(`schedule:${s.id}`, JSON.stringify(s));
      count++;
    }
  }
  if (count > 0) {
    logEvent('warn', `Paused ${count} schedule(s) for ${jid}: ${reason}`);
    await recordScheduleHistory({
      scheduleId: 'bulk',
      contactJid: jid,
      contactName: jid.split('@')[0],
      status: 'paused',
      reason: `Automated pause: ${reason}`
    });
  }
  return count;
}

/**
 * Generate preview of what the AI would write now for this schedule
 */
export async function previewScheduledMessage(data) {
  const {
    contactJid,
    purpose,
    mode = 'ai',
    exactText = '',
    messagesPerSend = 1
  } = data;

  if (mode === 'exact') {
    return {
      text: exactText || purpose || '',
      chunks: [exactText || purpose || '']
    };
  }

  const [memory, settings, resolvedName, ownerLearnedStyle] = await Promise.all([
    getChatMemory(contactJid),
    getSettings(),
    getResolvedContactName(contactJid),
    getLearnedStyle(contactJid)
  ]);

  const ownerName = settings.profile?.ownerName || 'JTech';
  const ownerFirst = settings.profile?.ownerFirstName || ownerName;
  const targetName = memory.settings?.displayName || resolvedName || 'there';
  const relationship = memory.settings?.relationship || 'friend';
  const customContactPrompt = memory.settings?.prompt || '';

  // Get last 5 messages for natural continuation
  const recentMessages = (memory.messages || []).slice(-5).map(m => 
    `${m.fromMe ? 'Owner' : targetName}: ${m.text}`
  ).join('\n');

  const systemInstruction = `
You are writing a WhatsApp text message on behalf of ${ownerName} (first name: ${ownerFirst}) to ${targetName} (${relationship}).
Texting voice: casual, warm, natural, respectful, first-person voice. Like a real person texting from their phone.
Never introduce yourself as an AI or a bot. Never say "how can I help you".
${customContactPrompt ? `Special instructions for this person: ${customContactPrompt}` : ''}
${ownerLearnedStyle?.globalStyle ? `Owner's natural texting habits: ${ownerLearnedStyle.globalStyle}` : ''}
`.trim();

  const userPrompt = `
Generate a fresh, natural WhatsApp message to ${targetName} with this purpose/topic:
"${purpose || 'Saying hello and checking in'}"

Context:
Recent conversation:
${recentMessages || '(No recent messages)'}

Known facts:
${(memory.facts || []).join(', ') || 'None'}

Requirements:
1. Write in ${targetName}'s language (English or Krio if appropriate).
2. Short, natural, friendly, 1-2 sentences.
3. If messagesPerSend is ${messagesPerSend} and > 1, you may split into up to ${messagesPerSend} separate messages using [SPLIT].
4. Output ONLY the message text. No explanations or quotes.
`.trim();

  const turns = [
    { role: 'user', text: userPrompt }
  ];

  try {
    const rawReply = await runAiCompletion({
      systemInstruction,
      turns,
      timeoutMs: 25000
    });
    const cleaned = sanitizeOutboundText(rawReply || '');
    const chunks = parseSplitChunks(cleaned);
    return {
      text: cleaned,
      chunks: chunks.length > 0 ? chunks : [cleaned]
    };
  } catch (err) {
    return {
      text: purpose || 'Checking in on you!',
      chunks: [purpose || 'Checking in on you!'],
      error: err.message
    };
  }
}

/**
 * Dispatch message with pacing and update chat memory
 */
async function sendScheduledMessage(schedule, text) {
  if (!state.sock) throw new Error('WhatsApp is disconnected');
  const contactJid = schedule.contactJid;
  if (!contactJid || contactJid.endsWith('@g.us')) {
    throw new Error('Invalid contact JID or group chat');
  }

  const settings = await getSettings();
  const pacing = settings.pacing || {};
  const chunks = parseSplitChunks(text);
  const toSend = chunks.length > 0 ? chunks : [text];

  const senderLabel = settings.profile?.ownerName ? `${settings.profile.ownerName} (AI Scheduled)` : 'You (Scheduled)';

  // Send chunks with natural typing pauses
  for (let i = 0; i < toSend.length; i++) {
    const chunk = toSend[i];
    if (pacing.typingDelayEnabled !== false) {
      const delay = calculateTypingDelay(chunk.length, pacing.typingSpeed || 'normal');
      try { await state.sock.sendPresenceUpdate('composing', contactJid); } catch (_) {}
      await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
      try { await state.sock.sendPresenceUpdate('paused', contactJid); } catch (_) {}
    }

    const sent = await state.sock.sendMessage(contactJid, { text: chunk });
    if (sent?.key?.id) {
      state.botSentMessageIds.add(sent.key.id);
    }

    if (i < toSend.length - 1) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  // Record in chat memory with scheduled metadata
  await recordMessage(contactJid, 'assistant', text, true, senderLabel);

  // Track chat metadata
  const metaRaw = await redis.get(`chat:${contactJid}:meta`);
  let meta = {};
  if (metaRaw) {
    try { meta = JSON.parse(metaRaw); } catch (_) {}
  }
  meta.lastScheduledAt = Date.now();
  meta.lastScheduledPurpose = schedule.purpose;
  await redis.set(`chat:${contactJid}:meta`, JSON.stringify(meta));

  // Update hourly and daily counters
  const now = Date.now();
  const hourKey = new Date(now).toISOString().slice(0, 13);
  const dayKey = new Date(now).toISOString().slice(0, 10);
  await Promise.all([
    redis.incr(`ratelimit:schedule:hourly:${hourKey}`),
    redis.incr(`ratelimit:schedule:daily:${dayKey}`),
    redis.incr(`ratelimit:schedule:contact:${contactJid}:${dayKey}`),
    redis.set(`ratelimit:schedule:contact_last:${contactJid}`, String(now))
  ]);
}

/**
 * Approve pending schedule send
 */
export async function approveScheduleSend(id, editedText = null) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');
  if (schedule.status !== 'pending_approval' && !schedule.pendingMessageText) {
    throw new Error('Schedule has no pending message to approve');
  }

  const messageToSend = editedText || schedule.pendingMessageText;
  const now = Date.now();

  try {
    await sendScheduledMessage(schedule, messageToSend);

    schedule.sendCount = (schedule.sendCount || 0) + 1;
    schedule.lastRunAt = now;
    schedule.lastMessageText = messageToSend;
    schedule.pendingMessageText = null;
    schedule.pendingGeneratedAt = null;
    schedule.retryCount = 0;

    // Advance schedule
    if (schedule.endType === 'max_sends' && schedule.sendCount >= schedule.maxSends) {
      schedule.status = 'completed';
      schedule.nextRunAt = null;
    } else if (schedule.repeat === 'once' || schedule.repeat === 'delay') {
      schedule.status = 'completed';
      schedule.nextRunAt = null;
    } else {
      schedule.status = 'active';
      schedule.nextRunAt = computeNextRun({
        repeat: schedule.repeat,
        repeatConfig: schedule.repeatConfig,
        now,
        lastRunAt: now
      });
      if (schedule.endType === 'date' && schedule.endDate) {
        if (schedule.nextRunAt > new Date(schedule.endDate).getTime()) {
          schedule.status = 'completed';
          schedule.nextRunAt = null;
        }
      }
    }

    schedule.updatedAt = now;
    await redis.set(`schedule:${id}`, JSON.stringify(schedule));

    await recordScheduleHistory({
      scheduleId: id,
      contactJid: schedule.contactJid,
      contactName: schedule.contactName,
      status: 'sent',
      text: messageToSend,
      reason: 'Approved by owner'
    });

    logEvent('info', `Approved and sent scheduled message [${id}] to ${schedule.contactName || schedule.contactJid}`);
    return { ok: true, schedule };
  } catch (err) {
    logEvent('error', `Failed to send approved message [${id}]: ${err.message}`);
    throw err;
  }
}

/**
 * Reject pending schedule send
 */
export async function rejectScheduleSend(id, reason = 'Rejected by owner') {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');

  const now = Date.now();
  schedule.pendingMessageText = null;
  schedule.pendingGeneratedAt = null;

  if (schedule.repeat === 'once' || schedule.repeat === 'delay') {
    schedule.status = 'completed';
    schedule.nextRunAt = null;
  } else {
    schedule.status = 'active';
    schedule.nextRunAt = computeNextRun({
      repeat: schedule.repeat,
      repeatConfig: schedule.repeatConfig,
      now,
      lastRunAt: now
    });
  }

  schedule.updatedAt = now;
  await redis.set(`schedule:${id}`, JSON.stringify(schedule));

  await recordScheduleHistory({
    scheduleId: id,
    contactJid: schedule.contactJid,
    contactName: schedule.contactName,
    status: 'rejected',
    reason
  });

  logEvent('info', `Rejected scheduled message [${id}]: ${reason}`);
  return { ok: true, schedule };
}

/**
 * Run schedule now (Manual execution trigger)
 */
export async function runScheduleNow(id) {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');

  let textToSend = schedule.pendingMessageText;
  if (!textToSend) {
    const preview = await previewScheduledMessage(schedule);
    textToSend = preview.text;
  }

  const now = Date.now();
  await sendScheduledMessage(schedule, textToSend);

  schedule.sendCount = (schedule.sendCount || 0) + 1;
  schedule.lastRunAt = now;
  schedule.lastMessageText = textToSend;
  schedule.pendingMessageText = null;
  schedule.pendingGeneratedAt = null;
  schedule.retryCount = 0;

  if (schedule.repeat === 'once' || schedule.repeat === 'delay') {
    schedule.status = 'completed';
    schedule.nextRunAt = null;
  } else if (schedule.endType === 'max_sends' && schedule.sendCount >= schedule.maxSends) {
    schedule.status = 'completed';
    schedule.nextRunAt = null;
  } else {
    schedule.status = 'active';
    schedule.nextRunAt = computeNextRun({
      repeat: schedule.repeat,
      repeatConfig: schedule.repeatConfig,
      now,
      lastRunAt: now
    });
  }

  schedule.updatedAt = now;
  await redis.set(`schedule:${id}`, JSON.stringify(schedule));

  await recordScheduleHistory({
    scheduleId: id,
    contactJid: schedule.contactJid,
    contactName: schedule.contactName,
    status: 'sent',
    text: textToSend,
    reason: 'Triggered manually by owner (Send now)'
  });

  logEvent('info', `Manually sent scheduled message [${id}] to ${schedule.contactName || schedule.contactJid}`);
  return { ok: true, schedule, text: textToSend };
}

/**
 * Primary 1-minute scheduler worker
 */
export async function checkScheduledTasks() {
  // Concurrency lock (1 minute TTL)
  const locked = await redis.set('lock:scheduler:tick', '1', { nx: true, ex: 55 });
  if (!locked) return;

  try {
    const settings = await getSettings();
    const limits = settings.scheduledLimits || {
      maxHourlyScheduledTotal: 10,
      maxDailyScheduledTotal: 30,
      maxDailyScheduledPerContact: 2,
      minScheduledGapMins: 60,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      schedulerGracePeriodHours: 3
    };

    const now = Date.now();
    const allSchedules = await listAllSchedules();
    const dueSchedules = allSchedules.filter(s => s.status === 'active' && s.nextRunAt && s.nextRunAt <= now);

    if (dueSchedules.length === 0) return;

    for (const schedule of dueSchedules) {
      const contactJid = schedule.contactJid;

      // 1. Check if missed by more than grace period (e.g. server was asleep > 3 hours)
      const gracePeriodMs = (limits.schedulerGracePeriodHours || 3) * 3600000;
      if (now - schedule.nextRunAt > gracePeriodMs) {
        const delayHours = ((now - schedule.nextRunAt) / 3600000).toFixed(1);
        logEvent('warn', `Schedule [${schedule.id}] for ${schedule.contactName} was missed by ${delayHours}h (> ${limits.schedulerGracePeriodHours}h grace period). Skipping.`);
        await recordScheduleHistory({
          scheduleId: schedule.id,
          contactJid,
          contactName: schedule.contactName,
          status: 'missed',
          reason: `Server was asleep/offline (missed by ${delayHours}h)`
        });

        // Compute next run and continue
        if (schedule.repeat === 'once' || schedule.repeat === 'delay') {
          schedule.status = 'completed';
          schedule.nextRunAt = null;
        } else {
          schedule.nextRunAt = computeNextRun({
            repeat: schedule.repeat,
            repeatConfig: schedule.repeatConfig,
            now,
            lastRunAt: now
          });
        }
        schedule.updatedAt = now;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        continue;
      }

      // 2. Check if WhatsApp is connected
      if (!state.sock || state.whatsappState !== 'connected') {
        logEvent('warn', `Schedule [${schedule.id}] due but WhatsApp is not connected. Will retry next minute within grace period.`);
        continue;
      }

      // 3. Check if bot is globally paused
      if (state.isManualPaused || settings.isPaused) {
        logEvent('info', `Schedule [${schedule.id}] postponed because bot is paused.`);
        continue;
      }

      // 4. Check if contact is in human takeover or chat is paused
      const [handoff, chatPause] = await Promise.all([
        redis.get(`handoff:${contactJid}`),
        isChatPaused(contactJid)
      ]);
      if (chatPause.isPaused) {
        logEvent('info', `Schedule [${schedule.id}] postponed because chat with ${contactJid} is paused.`);
        continue;
      }
      if (handoff) {
        logEvent('info', `Schedule [${schedule.id}] postponed because chat with ${contactJid} is in human takeover.`);
        continue;
      }

      // 5. Contact rules & mode check
      const mode = settings.contactRules?.mode || 'all';
      if (mode === 'blocklist' && matchesContactRule(contactJid, settings.contactRules?.blocklist || [])) {
        schedule.status = 'paused';
        schedule.updatedAt = now;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        logEvent('warn', `Paused schedule [${schedule.id}] because contact is in blocklist.`);
        continue;
      }
      if (mode === 'allowlist' && !matchesContactRule(contactJid, settings.contactRules?.allowlist || [])) {
        schedule.status = 'paused';
        schedule.updatedAt = now;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        logEvent('warn', `Paused schedule [${schedule.id}] because contact is not in allowlist.`);
        continue;
      }

      // 6. Quiet Hours check
      if (limits.quietHoursEnabled !== false && !schedule.sendEvenInQuietHours) {
        if (isInQuietHours(now, limits.quietHoursStart, limits.quietHoursEnd)) {
          const nextAwake = getQuietHoursEndTimestamp(now, limits.quietHoursEnd);
          schedule.nextRunAt = nextAwake;
          schedule.updatedAt = now;
          await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
          logEvent('info', `Schedule [${schedule.id}] delayed until quiet hours end (${new Date(nextAwake).toISOString()}).`);
          continue;
        }
      }

      // 7. Safety Rate Limits check
      const hourKey = new Date(now).toISOString().slice(0, 13);
      const dayKey = new Date(now).toISOString().slice(0, 10);
      const [curHourly, curDaily, curContactDaily, lastContactSent] = await Promise.all([
        redis.get(`ratelimit:schedule:hourly:${hourKey}`),
        redis.get(`ratelimit:schedule:daily:${dayKey}`),
        redis.get(`ratelimit:schedule:contact:${contactJid}:${dayKey}`),
        redis.get(`ratelimit:schedule:contact_last:${contactJid}`)
      ]);

      if (parseInt(curHourly || '0', 10) >= (limits.maxHourlyScheduledTotal || 10)) {
        logEvent('warn', `Schedule [${schedule.id}] delayed: hourly scheduled limit reached.`);
        schedule.nextRunAt = now + 15 * 60000;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        continue;
      }

      if (parseInt(curDaily || '0', 10) >= (limits.maxDailyScheduledTotal || 30)) {
        logEvent('warn', `Schedule [${schedule.id}] delayed: daily scheduled limit reached.`);
        schedule.nextRunAt = now + 60 * 60000;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        continue;
      }

      if (parseInt(curContactDaily || '0', 10) >= (limits.maxDailyScheduledPerContact || 2)) {
        logEvent('warn', `Schedule [${schedule.id}] delayed: daily per-contact limit reached for ${contactJid}.`);
        schedule.nextRunAt = now + 120 * 60000;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        continue;
      }

      const minGapMs = (limits.minScheduledGapMins || 60) * 60000;
      if (lastContactSent && (now - parseInt(lastContactSent, 10) < minGapMs)) {
        const waitRemaining = minGapMs - (now - parseInt(lastContactSent, 10));
        logEvent('info', `Schedule [${schedule.id}] waiting for minimum contact gap (${Math.ceil(waitRemaining / 60000)}m remaining).`);
        schedule.nextRunAt = now + waitRemaining + 5000;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        continue;
      }

      // 8. Generate message
      let messageText = schedule.pendingMessageText;
      if (!messageText) {
        const preview = await previewScheduledMessage(schedule);
        messageText = preview.text;
      }

      // 9. Ask me first check
      if (schedule.askMeFirst && schedule.status !== 'pending_approval') {
        schedule.status = 'pending_approval';
        schedule.pendingMessageText = messageText;
        schedule.pendingGeneratedAt = now;
        schedule.updatedAt = now;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));

        await recordScheduleHistory({
          scheduleId: schedule.id,
          contactJid,
          contactName: schedule.contactName,
          status: 'pending_approval',
          text: messageText,
          reason: 'Waiting for owner dashboard approval'
        });

        // Notify owner on WhatsApp if enabled
        if (settings.notifyOwnerOnWhatsApp && state.activePhone) {
          const ownerJid = `${state.activePhone}@s.whatsapp.net`;
          try {
            const alertMsg = `📋 [Scheduled Approval] Message ready for ${schedule.contactName || contactJid}:\n"${messageText.slice(0, 120)}"\nApprove in JTech dashboard.`;
            const alertSent = await state.sock.sendMessage(ownerJid, { text: alertMsg });
            if (alertSent?.key?.id) state.botSentMessageIds.add(alertSent.key.id);
          } catch (_) {}
        }

        logEvent('info', `Schedule [${schedule.id}] generated and waiting for owner approval.`);
        continue;
      }

      // If it is pending approval, do not auto-send! Wait for owner action
      if (schedule.status === 'pending_approval') {
        continue;
      }

      // 10. Send message
      try {
        await sendScheduledMessage(schedule, messageText);

        schedule.sendCount = (schedule.sendCount || 0) + 1;
        schedule.lastRunAt = now;
        schedule.lastMessageText = messageText;
        schedule.pendingMessageText = null;
        schedule.pendingGeneratedAt = null;
        schedule.retryCount = 0;

        if (schedule.repeat === 'once' || schedule.repeat === 'delay') {
          schedule.status = 'completed';
          schedule.nextRunAt = null;
        } else if (schedule.endType === 'max_sends' && schedule.sendCount >= schedule.maxSends) {
          schedule.status = 'completed';
          schedule.nextRunAt = null;
        } else {
          schedule.status = 'active';
          schedule.nextRunAt = computeNextRun({
            repeat: schedule.repeat,
            repeatConfig: schedule.repeatConfig,
            now,
            lastRunAt: now
          });
          if (schedule.endType === 'date' && schedule.endDate) {
            if (schedule.nextRunAt > new Date(schedule.endDate).getTime()) {
              schedule.status = 'completed';
              schedule.nextRunAt = null;
            }
          }
        }

        schedule.updatedAt = now;
        await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));

        await recordScheduleHistory({
          scheduleId: schedule.id,
          contactJid,
          contactName: schedule.contactName,
          status: 'sent',
          text: messageText
        });

        logEvent('info', `Successfully dispatched scheduled message [${schedule.id}] to ${schedule.contactName || contactJid}`);
      } catch (sendErr) {
        schedule.retryCount = (schedule.retryCount || 0) + 1;
        logEvent('error', `Error sending scheduled message [${schedule.id}] (attempt ${schedule.retryCount}/3): ${sendErr.message}`);

        if (schedule.retryCount >= 3) {
          schedule.status = 'failed';
          schedule.updatedAt = now;
          await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
          await recordScheduleHistory({
            scheduleId: schedule.id,
            contactJid,
            contactName: schedule.contactName,
            status: 'failed',
            reason: `Send failed after 3 attempts: ${sendErr.message}`
          });
        } else {
          // Retry in 2 minutes
          schedule.nextRunAt = now + 120000;
          schedule.updatedAt = now;
          await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] Worker tick error:', err);
  }
}

/**
 * Get earliest upcoming schedule and pending approval count
 */
export async function getSchedulerSummary() {
  try {
    const schedules = await listAllSchedules();
    let nextScheduled = null;
    let pendingApprovalCount = 0;

    const activeList = schedules.filter(s => s.status === 'active' && s.nextRunAt);
    if (activeList.length > 0) {
      activeList.sort((a, b) => a.nextRunAt - b.nextRunAt);
      const top = activeList[0];
      nextScheduled = {
        id: top.id,
        contactJid: top.contactJid,
        contactName: top.contactName || top.contactJid.split('@')[0],
        nextRunAt: top.nextRunAt,
        purpose: top.purpose
      };
    }

    pendingApprovalCount = schedules.filter(s => s.status === 'pending_approval').length;

    return { nextScheduled, pendingApprovalCount, totalCount: schedules.length };
  } catch (_) {
    return { nextScheduled: null, pendingApprovalCount: 0, totalCount: 0 };
  }
}

/**
 * Start the background 1-minute runner
 */
export function initScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(checkScheduledTasks, 60000);
  setTimeout(checkScheduledTasks, 5000);
  logEvent('info', 'Contact message scheduler started (1-minute resolution).');
}
