import express from 'express';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { getEventLog } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { getFreetownTime } from '../brain/prompt-builder.js';
import { checkAutoPause } from '../ai/index.js';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  GEMINI_API_KEY,
  GROQ_API_KEY
} from '../config.js';
import { getSchedulerSummary } from '../lib/scheduler.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.get('/state', requireAuth, async (req, res) => {
  try {
    const isPaused = await checkAutoPause();
    const remainingPauseSecs = isPaused ? Math.max(0, Math.ceil((state.autoPauseUntil - Date.now()) / 1000)) : 0;
    const settings = await getSettings();
    const today = new Date().toISOString().slice(0, 10);
    const [
      repliesToday,
      geminiCount,
      groqCount,
      rawErrors,
      upstashStatus,
      rawTeachMe,
      rawSummary,
      rawLearnedStyle,
      schedulerSummary
    ] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4),
      redis.ping(),
      redis.hgetall('teachme:items'),
      redis.get('summary:latest'),
      redis.get('owner:style:global'),
      getSchedulerSummary()
    ]);

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

    const recentErrors = [];
    for (const item of (rawErrors || [])) {
      try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
    }

    const effectiveWhatsappState = state.sock?.user
      ? 'connected'
      : (state.hasSavedSession ? 'reconnecting' : state.whatsappState);

    const linkedNumber = state.linkedNumber || state.activePhone || '';

    res.json({
      server: {
        live: true,
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version
      },
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
        gemini: Boolean(process.env.GEMINI_API_KEY || GEMINI_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY || GROQ_API_KEY),
        upstash: upstashStatus,
        lastAiTest: state.lastAiTest
      },
      events: getEventLog().reverse(),
      globalRateLimit: {
        isLimited: state.isGlobalRateLimited && (state.globalRateLimitResetAt > Date.now()),
        resetAt: state.globalRateLimitResetAt
      },
      teachMeCount,
      latestDailySummary,
      learnedStyle: rawLearnedStyle || '',
      nextScheduled: schedulerSummary?.nextScheduled || null,
      pendingApprovalCount: schedulerSummary?.pendingApprovalCount || 0,
      totalSchedules: schedulerSummary?.totalCount || 0,
      // Backward-compatible fields:
      uptime: Math.floor(process.uptime()),
      status: effectiveWhatsappState,
      connectionPill: effectiveWhatsappState === 'connected' ? 'Connected' : (effectiveWhatsappState === 'reconnecting' || effectiveWhatsappState === 'connecting' ? 'Reconnecting...' : (effectiveWhatsappState === 'code_ready' ? 'Code Ready' : 'Not linked')),
      activePhone: linkedNumber,
      isAutoPaused: false, // Master switch is owner-only
      remainingPauseSecs: 0,
      isManualPaused: settings.isPaused,
      consecutiveFailures: state.consecutiveFailures,
      activeProvider: settings.provider,
      geminiModel: settings.geminiModel,
      groqModel: settings.groqModel,
      freetownTime: getFreetownTime(),
      repliesToday: parseInt(repliesToday || '0', 10),
      providers: {
        gemini: parseInt(geminiCount || '0', 10),
        groq: parseInt(groqCount || '0', 10)
      },
      recentErrors,
      keys: {
        gemini: Boolean(process.env.GEMINI_API_KEY || GEMINI_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY || GROQ_API_KEY),
        redis: upstashStatus === 'ok'
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
