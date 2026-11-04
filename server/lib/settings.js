import { redis } from './redis.js';
import {
  DEFAULT_PROFILE,
  DEFAULT_PERSONAL_PROMPT,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  SETTINGS_CACHE_TTL
} from '../config.js';

let cachedSettings = null;
let lastSettingsFetch = 0;

export async function getSettings(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSettings && (now - lastSettingsFetch < SETTINGS_CACHE_TTL)) {
    return cachedSettings;
  }

  try {
    const [
      rawProfile,
      rawPersonalPrompt,
      legacyRules,
      provider,
      geminiModel,
      groqModel,
      minDelay,
      maxDelay,
      isPaused,
      contactRules,
      rawNotifyOwner,
      rawPacing,
      rawLearnReplies,
      rawDailySummaryEnabled,
      rawDailySummaryTime,
      rawScheduledLimits
    ] = await Promise.all([
      redis.get('config:owner_profile'),
      redis.get('config:personal_prompt'),
      redis.get('config:base_rules'),
      redis.get('config:ai_provider'),
      redis.get('config:gemini_model'),
      redis.get('config:groq_model'),
      redis.get('config:min_delay'),
      redis.get('config:max_delay'),
      redis.get('config:is_paused'),
      redis.get('config:contact_rules'),
      redis.get('config:notify_owner'),
      redis.get('config:pacing_settings'),
      redis.get('config:learn_from_replies'),
      redis.get('config:daily_summary_enabled'),
      redis.get('config:daily_summary_time'),
      redis.get('config:scheduled_limits')
    ]);

    let profile = { ...DEFAULT_PROFILE };
    if (rawProfile) {
      try {
        const parsed = JSON.parse(rawProfile);
        profile = { ...DEFAULT_PROFILE, ...parsed };
      } catch (_) {}
    }
    // Delete legacy sample messages and city if present
    delete profile.city;
    delete profile.sampleMessage1;
    delete profile.sampleMessage2;
    delete profile.sampleMessage3;

    let rules = contactRules ? JSON.parse(contactRules) : { mode: 'all', allowlist: [], blocklist: [] };

    // Automatic migration of legacy baseRules to personalPrompt on first load if personalPrompt is not yet set
    let personalPrompt = rawPersonalPrompt;
    if (!personalPrompt && legacyRules) {
      personalPrompt = legacyRules;
      await redis.set('config:personal_prompt', legacyRules);
    }
    if (!personalPrompt) {
      personalPrompt = DEFAULT_PERSONAL_PROMPT;
    }

    let pacing = {
      typingDelayEnabled: true,
      typingSpeed: 'normal',
      batchingEnabled: true,
      batchWindowSec: 5,
      splitRepliesEnabled: true,
      reactionsEnabled: true,
      maxHourlyRepliesPerContact: 30,
      maxHourlyRepliesGlobal: 150
    };
    if (rawPacing) {
      try {
        pacing = { ...pacing, ...JSON.parse(rawPacing) };
      } catch (_) {}
    }

    let scheduledLimits = {
      maxHourlyScheduledTotal: 10,
      maxDailyScheduledTotal: 30,
      maxDailyScheduledPerContact: 2,
      minScheduledGapMins: 60,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      schedulerGracePeriodHours: 3
    };
    if (rawScheduledLimits) {
      try {
        scheduledLimits = { ...scheduledLimits, ...JSON.parse(rawScheduledLimits) };
      } catch (_) {}
    }

    cachedSettings = {
      profile,
      personalPrompt,
      baseRules: personalPrompt, // Maintain backward compatibility for UI/API
      provider: provider || 'gemini',
      geminiModel: geminiModel || DEFAULT_GEMINI_MODEL,
      groqModel: groqModel || DEFAULT_GROQ_MODEL,
      minDelay: parseInt(minDelay || '300', 10),
      maxDelay: parseInt(maxDelay || '1200', 10),
      isPaused: isPaused === 'true',
      notifyOwnerOnWhatsApp: rawNotifyOwner === 'true',
      contactRules: rules,
      pacing,
      learnFromReplies: rawLearnReplies !== 'false',
      dailySummaryEnabled: rawDailySummaryEnabled !== 'false',
      dailySummaryTime: rawDailySummaryTime || '21:00',
      scheduledLimits
    };
    lastSettingsFetch = now;
    return cachedSettings;
  } catch (err) {
    console.error('[Settings] Cache refresh error:', err.message);
    return cachedSettings || {
      profile: DEFAULT_PROFILE,
      personalPrompt: DEFAULT_PERSONAL_PROMPT,
      baseRules: DEFAULT_PERSONAL_PROMPT,
      provider: 'gemini',
      geminiModel: DEFAULT_GEMINI_MODEL,
      groqModel: DEFAULT_GROQ_MODEL,
      minDelay: 300,
      maxDelay: 1200,
      isPaused: false,
      contactRules: { mode: 'all', allowlist: [], blocklist: [] },
      pacing: {
        typingDelayEnabled: true,
        typingSpeed: 'normal',
        batchingEnabled: true,
        batchWindowSec: 5,
        splitRepliesEnabled: true,
        reactionsEnabled: true,
        maxHourlyRepliesPerContact: 30,
        maxHourlyRepliesGlobal: 150
      },
      learnFromReplies: true,
      dailySummaryEnabled: true,
      dailySummaryTime: '21:00'
    };
  }
}

export function invalidateSettingsCache() {
  cachedSettings = null;
  lastSettingsFetch = 0;
}
