import express from 'express';
import { requireAuth } from './auth.js';
import { getRedisUsage, invalidateUsageCache } from '../lib/upstash-usage.js';

const router = express.Router();

router.get('/redis-usage', requireAuth, async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const usage = await getRedisUsage(force);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/redis-usage/refresh', requireAuth, async (req, res) => {
  try {
    invalidateUsageCache();
    const usage = await getRedisUsage(true);
    res.json({ success: true, usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
