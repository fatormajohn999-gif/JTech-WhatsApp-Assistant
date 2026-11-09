import express from 'express';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { getEventLog } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { getFreetownTime } from '../brain/prompt-builder.js';
import { checkAutoPause } from '../ai/index.js';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL
} from '../config.js';
import { getSchedulerSummary } from '../lib/scheduler.js';
import { getApiKeysStatus } from '../lib/keys.js';
import { requireAuth } from './auth.js';

const router = express.Router();

let cachedDbStats = null;
let lastDbStatsFetch = 0;
const DB_STATS_CACHE_TTL = 8000; // 8 seconds cache to dramatically reduce Redis commands

router.get('/state', requireAuth, async (req, res) => {
  try {
    const isPaused = await checkAutoPause();
    const remainingPauseSecs = isPaused ? Math.max(0, Math.ceil((state.autoPauseUntil - Date.now()) / 1000)) : 0;
    const settings = await getSettings();
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // Refresh database statistics if cache expired
    if (!cachedDbStats || (now - lastDbStatsFetch >= DB_STATS_CACHE_TTL)) {
      const [
        batchedStats,
        rawErrors,
        rawTeachMe,
        schedulerSummary
      ] = await Promise.all([
        redis.mget(
          `stats:replies:${today}`,
          'stats:provider:gemini',
          'stats:provider:groq',
          'summary:latest',
          'owner:style:global'
        ),
        redis.lrange('stats:ai_errors', 0, 4),
        redis.hgetall('teachme:items'),
        getSchedulerSummary()
      ]);

      const [repliesToday, geminiCount, groqCount, rawSummary, rawLearnedStyle] = batchedStats || [];

      let teachMeCount = 0;
      if (rawTeachMe) {
        for (const val of Object.values(rawTeachMe)) {
          try {
            if (JSON.parse(val).status === 'pending') teachMeCount++;
          } catch (_) {}
        }
      }

      let latestDailySummary = null;
      if (rawSummary) {
        try { latestDailySummary = JSON.parse(rawSummary); } catch (_) {}
      }

      const recentErrors = [];
      for (const item of (rawErrors || [])) {
        try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
      }

      cachedDbStats = {
        repliesToday: parseInt(repliesToday || '0', 10),
        geminiCount: parseInt(geminiCount || '0', 10),
        groqCount: parseInt(groqCount || '0', 10),
        teachMeCount,
        latestDailySummary,
        learnedStyle: rawLearnedStyle || '',
        schedulerSummary,
        recentErrors,
        upstashStatus: 'ok'
      };
      lastDbStatsFetch = now;
    }

    const pairingSecondsLeft = state.pairingExpiresAt > Date.now()
      ? Math.max(0, Math.ceil((state.pairingExpiresAt - Date.now()) / 1000))
      : 0;

    // Clear expired code
    if (state.currentPairingCode && pairingSecondsLeft === 0) {
      state.currentPairingCode = null;
      if (state.whatsappState === 'code_ready') {
        state.setWhatsappState('not_linked');
      }
    }

    const effectiveWhatsappState = state.sock?.user
      ? 'connected'
      : (state.hasSavedSession ? 'reconnecting' : state.whatsappState);

    const linkedNumber = state.linkedNumber || state.activePhone || '';
    const keysStatus = await getApiKeysStatus();

    res.json({
      server: {
        live: true,
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version
      },
      identity: settings.identity || null,
      personality: settings.personality || null,
      temperature: settings.temperature ?? 0.85,
      whatsapp: {
        state: effectiveWhatsappState,
        phone: linkedNumber,
        linkedNumber,
        hasSavedSession: Boolean(state.hasSavedSession),
        since: state.whatsappStateSince
      },
      hasSavedSession: Boolean(state.hasSavedSession),
      linkedNumber,
      pairing: {
        code: state.currentPairingCode,
        expiresAt: state.pairingExpiresAt,
        secondsLeft: pairingSecondsLeft,
        qr: state.latestQrString,
        qrDataUrl: state.latestQrDataUrl,
        qrSecondsLeft: state.latestQrExpiresAt ? Math.max(0, Math.ceil((state.latestQrExpiresAt - Date.now()) / 1000)) : 0
      },
      lastError: state.lastError,
      aiLimited: state.aiLimited && state.aiLimited.until > Date.now() ? state.aiLimited : null,
      currentModels: {
        gemini: settings.geminiModel || DEFAULT_GEMINI_MODEL,
        groq: settings.groqModel || DEFAULT_GROQ_MODEL
      },
      services: {
        gemini: keysStatus.gemini.configured,
        groq: keysStatus.groq.configured,
        upstash: cachedDbStats.upstashStatus,
        lastAiTest: state.lastAiTest
      },
      apiKeys: keysStatus,
      events: getEventLog().reverse(),
      globalRateLimit: {
        isLimited: state.isGlobalRateLimited && (state.globalRateLimitResetAt > Date.now()),
        resetAt: state.globalRateLimitResetAt
      },
      teachMeCount: cachedDbStats.teachMeCount,
      latestDailySummary: cachedDbStats.latestDailySummary,
      learnedStyle: cachedDbStats.learnedStyle,
      nextScheduled: cachedDbStats.schedulerSummary?.nextScheduled || null,
      pendingApprovalCount: cachedDbStats.schedulerSummary?.pendingApprovalCount || 0,
      totalSchedules: cachedDbStats.schedulerSummary?.totalCount || 0,
      // Backward-compatible fields:
      uptime: Math.floor(process.uptime()),
      status: effectiveWhatsappState,
      connectionPill: effectiveWhatsappState === 'connected' ? 'Connected' : (effectiveWhatsappState === 'reconnecting' || effectiveWhatsappState === 'connecting' ? 'Reconnecting...' : (effectiveWhatsappState === 'code_ready' ? 'Code Ready' : 'Not linked')),
      activePhone: linkedNumber,
      isAutoPaused: false,
      remainingPauseSecs,
      isManualPaused: settings.isPaused,
      consecutiveFailures: state.consecutiveFailures,
      activeProvider: settings.provider,
      geminiModel: settings.geminiModel,
      groqModel: settings.groqModel,
      freetownTime: getFreetownTime(),
      repliesToday: cachedDbStats.repliesToday,
      providers: {
        gemini: cachedDbStats.geminiCount,
        groq: cachedDbStats.groqCount
      },
      recentErrors: cachedDbStats.recentErrors,
      keys: {
        gemini: keysStatus.gemini.configured,
        groq: keysStatus.groq.configured,
        redis: cachedDbStats.upstashStatus === 'ok'
      }
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'STATE_FETCH_FAILED',
      hint: 'Unable to retrieve status. Ensure Upstash Redis credentials are functioning.'
    });
  }
});

export default router;
