import express from 'express';
import crypto from 'crypto';
import { DASHBOARD_PASSWORD } from '../config.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const valid = await redis.get('session:' + token);
      if (valid) {
        return next();
      }
    }
  }

  // Fallback for x-pass header only (NO query parameters)
  const pass = req.headers['x-pass'];
  if (DASHBOARD_PASSWORD && pass && timingSafeEqualStr(String(pass), String(DASHBOARD_PASSWORD))) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Invalid or expired token',
    code: 'UNAUTHORIZED',
    hint: 'Please sign in with your DASHBOARD_PASSWORD to continue.'
  });
}

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    if (!DASHBOARD_PASSWORD) {
      logEvent('warn', 'Login attempt rejected: DASHBOARD_PASSWORD is not set in server environment.');
      return res.status(500).json({
        error: 'Server authentication unconfigured: DASHBOARD_PASSWORD missing',
        code: 'AUTH_UNCONFIGURED',
        hint: 'Configure the DASHBOARD_PASSWORD variable in your Render dashboard Environment settings.'
      });
    }

    const { password } = req.body;
    if (!password || !timingSafeEqualStr(String(password), String(DASHBOARD_PASSWORD))) {
      return res.status(401).json({
        error: 'Incorrect dashboard password',
        code: 'INVALID_CREDENTIALS',
        hint: 'Please re-enter your DASHBOARD_PASSWORD exactly as set in Render.'
      });
    }

    const token = crypto.randomBytes(24).toString('hex');
    await redis.set('session:' + token, '1', { ex: 86400 * 14 }); // 14 days TTL
    logEvent('info', 'Dashboard authenticated successfully via password.');
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'LOGIN_FAILED',
      hint: 'An unexpected error occurred during sign in. Check system logs.'
    });
  }
});

export default router;
