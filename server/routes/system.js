import express from 'express';
import path from 'path';
import fs from 'fs';
import { ROOT_DIR, RENDER_EXTERNAL_URL } from '../config.js';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent, getLiveLogs } from '../lib/logger.js';
import { requireAuth } from './auth.js';

const router = express.Router();

// Public health check routes (Fast, no secrets, no auth for uptime monitors)
router.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'ok',
    app: 'JTech Assistant',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    whatsapp: state.whatsappState
  });
});

router.get('/api/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'ok',
    app: 'JTech Assistant',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    whatsapp: state.whatsappState
  });
});

// Authenticated live server log stream (ring buffer of stdout/stderr)
router.get('/api/logs', requireAuth, (req, res) => {
  const afterId = parseInt(req.query.after || '0', 10) || 0;
  const limit = Math.min(500, parseInt(req.query.limit || '200', 10) || 200);
  const level = req.query.level || 'all';
  const logs = getLiveLogs(afterId, limit, level);
  res.json({ logs, after: logs.length > 0 ? logs[logs.length - 1].id : afterId });
});

router.get('/logs', requireAuth, (req, res) => {
  const afterId = parseInt(req.query.after || '0', 10) || 0;
  const limit = Math.min(500, parseInt(req.query.limit || '200', 10) || 200);
  const level = req.query.level || 'all';
  const logs = getLiveLogs(afterId, limit, level);
  res.json({ logs, after: logs.length > 0 ? logs[logs.length - 1].id : afterId });
});

// Telemetry statistics
router.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [repliesToday, geminiCount, groqCount, rawErrors] = await Promise.all([
      redis.get(`stats:replies:${today}`),
      redis.get('stats:provider:gemini'),
      redis.get('stats:provider:groq'),
      redis.lrange('stats:ai_errors', 0, 4)
    ]);

    const recentErrors = [];
    for (const item of (rawErrors || [])) {
      try { recentErrors.push(JSON.parse(item)); } catch (_) { recentErrors.push({ message: item, timestamp: Date.now() }); }
    }

    res.json({
      repliesToday: parseInt(repliesToday || '0', 10),
      providers: {
        gemini: parseInt(geminiCount || '0', 10),
        groq: parseInt(groqCount || '0', 10)
      },
      uptime: Math.floor(process.uptime()),
      recentErrors
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'STATS_FAILED',
      hint: 'Could not fetch telemetry stats.'
    });
  }
});

// Backward compatibility aliases
router.get('/api/status', requireAuth, (req, res) => res.redirect('/api/state'));
router.get('/api/usage', requireAuth, (req, res) => res.redirect('/api/stats'));
router.get('/api/settings', requireAuth, (req, res) => res.redirect('/api/cfg'));
router.post('/api/settings', requireAuth, (req, res) => res.redirect(307, '/api/cfg'));
router.post('/api/logout', requireAuth, (req, res) => res.redirect(307, '/api/logout-wa'));
router.post('/api/clear-all-memory', requireAuth, (req, res) => res.redirect(307, '/api/clear-memory'));

// UI HTML static serving
router.get('/', (req, res) => {
  const uiPath = path.join(ROOT_DIR, 'ui.html');
  if (fs.existsSync(uiPath)) {
    res.sendFile(uiPath);
  } else {
    res.send('ui.html not found');
  }
});

router.get('/ui.html', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'ui.html'));
});

// Self-ping keep-awake loop for Render free tier
export function initKeepAwake() {
  if (RENDER_EXTERNAL_URL) {
    const pingUrl = `${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/health`;
    logEvent('info', `Keep-awake initialized: self-pinging ${pingUrl} every 4 minutes.`);
    setInterval(async () => {
      try {
        const resp = await fetch(pingUrl);
        if (!resp.ok) {
          logEvent('warn', `Keep-awake self-ping returned status ${resp.status}`);
        }
      } catch (e) {
        logEvent('warn', `Keep-awake self-ping failed: ${e.message}`);
      }
    }, 4 * 60 * 1000);
  }
}

export default router;
