import express from 'express';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getSettings, invalidateSettingsCache } from '../lib/settings.js';
import { startWhatsApp, logoutWhatsApp } from '../whatsapp/socket.js';
import { clearAllMemory } from '../memory/store.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.get('/cfg', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings(true);
    res.json(settings);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONFIG_FETCH_FAILED',
      hint: 'Could not load configuration from Redis.'
    });
  }
});

router.post('/cfg', requireAuth, async (req, res) => {
  try {
    const {
      profile,
      personalPrompt,
      baseRules,
      provider,
      geminiModel,
      groqModel,
      minDelay,
      maxDelay,
      isPaused,
      notifyOwnerOnWhatsApp,
      contactRules,
      pacing,
      learnFromReplies,
      dailySummaryEnabled,
      dailySummaryTime,
      scheduledLimits
    } = req.body;

    if (profile && typeof profile === 'object') {
      const cleanProfile = { ...profile };
      delete cleanProfile.city;
      delete cleanProfile.sampleMessage1;
      delete cleanProfile.sampleMessage2;
      delete cleanProfile.sampleMessage3;
      await redis.set('config:owner_profile', JSON.stringify(cleanProfile));
    }

    // Save personalPrompt; if client sent baseRules instead, support it transparently
    const promptToSave = personalPrompt !== undefined ? personalPrompt : baseRules;
    if (typeof promptToSave === 'string') {
      const cleanPrompt = promptToSave.trim();
      await redis.set('config:personal_prompt', cleanPrompt);
      await redis.set('config:base_rules', cleanPrompt); // Keep backward compatible
    }

    if (provider && (provider === 'gemini' || provider === 'groq')) {
      await redis.set('config:ai_provider', provider);
    }
    if (geminiModel) await redis.set('config:gemini_model', String(geminiModel).trim());
    if (groqModel) await redis.set('config:groq_model', String(groqModel).trim());
    if (minDelay !== undefined) await redis.set('config:min_delay', String(minDelay));
    if (maxDelay !== undefined) await redis.set('config:max_delay', String(maxDelay));
    if (isPaused !== undefined) await redis.set('config:is_paused', isPaused ? 'true' : 'false');
    if (notifyOwnerOnWhatsApp !== undefined) await redis.set('config:notify_owner', notifyOwnerOnWhatsApp ? 'true' : 'false');
    if (learnFromReplies !== undefined) await redis.set('config:learn_from_replies', learnFromReplies ? 'true' : 'false');
    if (dailySummaryEnabled !== undefined) await redis.set('config:daily_summary_enabled', dailySummaryEnabled ? 'true' : 'false');
    if (dailySummaryTime) await redis.set('config:daily_summary_time', String(dailySummaryTime).trim());

    if (contactRules && typeof contactRules === 'object') {
      const mode = ['all', 'allowlist', 'blocklist'].includes(contactRules.mode) ? contactRules.mode : 'all';
      const cleanList = arr => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean) : [];
      await redis.set('config:contact_rules', JSON.stringify({
        mode,
        allowlist: cleanList(contactRules.allowlist),
        blocklist: cleanList(contactRules.blocklist)
      }));
    }

    if (pacing && typeof pacing === 'object') {
      const currentRaw = await redis.get('config:pacing_settings');
      let current = {
        typingDelayEnabled: true,
        typingSpeed: 'normal',
        batchingEnabled: true,
        batchWindowSec: 5,
        splitRepliesEnabled: true,
        reactionsEnabled: true,
        maxHourlyRepliesPerContact: 30,
        maxHourlyRepliesGlobal: 150
      };
      if (currentRaw) {
        try { current = { ...current, ...JSON.parse(currentRaw) }; } catch (_) {}
      }

      const updatedPacing = {
        typingDelayEnabled: pacing.typingDelayEnabled !== undefined ? Boolean(pacing.typingDelayEnabled) : current.typingDelayEnabled,
        typingSpeed: ['fast', 'normal', 'slow'].includes(pacing.typingSpeed) ? pacing.typingSpeed : current.typingSpeed,
        batchingEnabled: pacing.batchingEnabled !== undefined ? Boolean(pacing.batchingEnabled) : current.batchingEnabled,
        batchWindowSec: Math.min(12, Math.max(2, parseInt(pacing.batchWindowSec ?? current.batchWindowSec, 10) || 5)),
        splitRepliesEnabled: pacing.splitRepliesEnabled !== undefined ? Boolean(pacing.splitRepliesEnabled) : current.splitRepliesEnabled,
        reactionsEnabled: pacing.reactionsEnabled !== undefined ? Boolean(pacing.reactionsEnabled) : current.reactionsEnabled,
        maxHourlyRepliesPerContact: Math.max(1, parseInt(pacing.maxHourlyRepliesPerContact ?? current.maxHourlyRepliesPerContact, 10) || 30),
        maxHourlyRepliesGlobal: Math.max(1, parseInt(pacing.maxHourlyRepliesGlobal ?? current.maxHourlyRepliesGlobal, 10) || 150)
      };
      await redis.set('config:pacing_settings', JSON.stringify(updatedPacing));
    }

    if (scheduledLimits && typeof scheduledLimits === 'object') {
      const currentLimitsRaw = await redis.get('config:scheduled_limits');
      let currentLimits = {
        maxHourlyScheduledTotal: 10,
        maxDailyScheduledTotal: 30,
        maxDailyScheduledPerContact: 2,
        minScheduledGapMins: 60,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        schedulerGracePeriodHours: 3
      };
      if (currentLimitsRaw) {
        try { currentLimits = { ...currentLimits, ...JSON.parse(currentLimitsRaw) }; } catch (_) {}
      }
      const updatedLimits = {
        maxHourlyScheduledTotal: Math.max(1, parseInt(scheduledLimits.maxHourlyScheduledTotal ?? currentLimits.maxHourlyScheduledTotal, 10) || 10),
        maxDailyScheduledTotal: Math.max(1, parseInt(scheduledLimits.maxDailyScheduledTotal ?? currentLimits.maxDailyScheduledTotal, 10) || 30),
        maxDailyScheduledPerContact: Math.max(1, parseInt(scheduledLimits.maxDailyScheduledPerContact ?? currentLimits.maxDailyScheduledPerContact, 10) || 2),
        minScheduledGapMins: Math.max(0, parseInt(scheduledLimits.minScheduledGapMins ?? currentLimits.minScheduledGapMins, 10) || 60),
        quietHoursEnabled: scheduledLimits.quietHoursEnabled !== undefined ? Boolean(scheduledLimits.quietHoursEnabled) : currentLimits.quietHoursEnabled,
        quietHoursStart: scheduledLimits.quietHoursStart || currentLimits.quietHoursStart || '22:00',
        quietHoursEnd: scheduledLimits.quietHoursEnd || currentLimits.quietHoursEnd || '07:00',
        schedulerGracePeriodHours: Math.max(1, parseInt(scheduledLimits.schedulerGracePeriodHours ?? currentLimits.schedulerGracePeriodHours, 10) || 3)
      };
      await redis.set('config:scheduled_limits', JSON.stringify(updatedLimits));
    }

    invalidateSettingsCache();
    logEvent('info', 'Configuration updated successfully.');
    res.json({ success: true, message: 'Configuration saved successfully' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CONFIG_SAVE_FAILED',
      hint: 'Unable to write settings to Redis. Check database connection.'
    });
  }
});

router.post('/reconnect-wa', requireAuth, async (req, res) => {
  try {
    logEvent('info', 'Manual reconnect requested from dashboard.');
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.sock) {
      try { state.sock.end(undefined); } catch (_) {}
    }
    state.setWhatsappState('connecting');
    startWhatsApp();
    res.json({
      success: true,
      message: 'Reconnecting WhatsApp socket...',
      state: state.whatsappState
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RECONNECT_FAILED',
      hint: 'Try again in a few seconds or check server logs in Settings.'
    });
  }
});

router.post('/logout-wa', requireAuth, async (req, res) => {
  try {
    await logoutWhatsApp();
    logEvent('info', 'WhatsApp session disconnected and credentials wiped by user request.');
    res.json({ success: true, message: 'Logged out and wa:* keys cleared from Redis' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'LOGOUT_FAILED',
      hint: 'Could not gracefully log out socket. Try reconnecting.'
    });
  }
});

router.post('/unlink-wa', requireAuth, async (req, res) => {
  try {
    await logoutWhatsApp();
    logEvent('info', 'WhatsApp session unlinked by user request.');
    res.json({ success: true, message: 'WhatsApp session unlinked successfully.' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'UNLINK_FAILED',
      hint: 'Could not unlink WhatsApp session.'
    });
  }
});

router.post('/clear-memory', requireAuth, async (req, res) => {
  try {
    await clearAllMemory();
    res.json({ success: true, message: 'All contact chat memory and summaries cleared.' });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CLEAR_MEMORY_FAILED',
      hint: 'Error deleting keys from Redis.'
    });
  }
});

export default router;
