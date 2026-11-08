import { redis } from './redis.js';
import {
  DEFAULT_PROFILE,
  DEFAULT_PERSONAL_PROMPT,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  SETTINGS_CACHE_TTL
} from '../config.js';
import { getApiKeysStatus } from './keys.js';

let cachedSettings = null;
let lastSettingsFetch = 0;

export const DEFAULT_IDENTITY = {
  assistantName: 'JTech Assistant',
  ownerName: 'JTech',
  ownerFirstName: '',
  ownerPreferredName: '',
  appTitle: 'JTech Assistant',
  ownerAbout: 'Leading tech brand and software solutions in Freetown, Sierra Leone. Dedicated to building innovative software, web, and mobile solutions.',
  languages: 'English, Krio',
  writingStyle: 'Warm, natural, respectful, and direct. Sounds like a real person texting from their phone.'
};

export const DEFAULT_PERSONALITY = {
  replyLength: 'medium', // 'short' (1 short sentence, 10-25 words), 'medium' (1-3 natural sentences, 15-50 words), 'detailed' (2-4 thoughtful sentences)
  playfulness: 'medium', // 'low', 'medium', 'high'
  formality: 'balanced', // 'casual', 'balanced', 'formal'
  emojiLevel: 'low',     // 'none', 'low', 'moderate', 'high'
  temperature: 0.85      // 0.0 to 1.0 (default 0.85)
};

export async function getSettings(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSettings && (now - lastSettingsFetch < SETTINGS_CACHE_TTL)) {
    return cachedSettings;
  }

  try {
    const [
      rawProfile,
      rawIdentity,
      rawPersonality,
      rawTemperature,
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
      redis.get('config:identity'),
      redis.get('config:personality'),
      redis.get('config:temperature'),
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
    delete profile.city;
    delete profile.sampleMessage1;
    delete profile.sampleMessage2;
    delete profile.sampleMessage3;

    let identity = {
      ...DEFAULT_IDENTITY,
      ownerName: profile.ownerName || DEFAULT_IDENTITY.ownerName,
      ownerFirstName: profile.ownerFirstName || DEFAULT_IDENTITY.ownerFirstName,
      ownerAbout: profile.ownerAbout || DEFAULT_IDENTITY.ownerAbout,
      languages: profile.ownerLanguages || profile.languages || DEFAULT_IDENTITY.languages,
      writingStyle: profile.writingStyle || DEFAULT_IDENTITY.writingStyle
    };
    if (rawIdentity) {
      try {
        identity = { ...identity, ...JSON.parse(rawIdentity) };
      } catch (_) {}
    }

    let personality = { ...DEFAULT_PERSONALITY };
    if (rawPersonality) {
      try {
        personality = { ...DEFAULT_PERSONALITY, ...JSON.parse(rawPersonality) };
      } catch (_) {}
    }

    const temperature = rawTemperature !== null && rawTemperature !== undefined
      ? Math.max(0.0, Math.min(1.0, parseFloat(rawTemperature) || 0.85))
      : (personality.temperature ?? 0.85);
    personality.temperature = temperature;

    let rules = contactRules ? JSON.parse(contactRules) : { mode: 'all', allowlist: [], blocklist: [] };

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

    const apiKeys = await getApiKeysStatus();

    cachedSettings = {
      profile,
      identity,
      personality,
      temperature,
      personalPrompt,
      baseRules: personalPrompt,
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
      scheduledLimits,
      apiKeys
    };
    lastSettingsFetch = now;
    return cachedSettings;
  } catch (err) {
    console.error('[Settings] Cache refresh error:', err.message);
    return cachedSettings || {
      profile: DEFAULT_PROFILE,
      identity: DEFAULT_IDENTITY,
      personality: DEFAULT_PERSONALITY,
      temperature: 0.85,
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
      dailySummaryTime: '21:00',
      apiKeys: {
        gemini: { configured: false, masked: null },
        groq: { configured: false, masked: null }
      }
    };
  }
}

export function invalidateSettingsCache() {
  cachedSettings = null;
  lastSettingsFetch = 0;
}
