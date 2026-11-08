import express from 'express';
import crypto from 'crypto';
import { DASHBOARD_PASSWORD } from '../config.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';

const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days sliding TTL

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

export async function verifyPassword(password) {
  if (!password || typeof password !== 'string') return false;
  try {
    const stored = await redis.get('auth:password_hash');
    if (stored && typeof stored === 'string' && stored.includes(':')) {
      const [salt, hash] = stored.split(':');
      if (salt && hash) {
        const computed = crypto.scryptSync(password, salt, 64).toString('hex');
        return timingSafeEqualStr(computed, hash);
      }
    }
  } catch (err) {
    console.error('[Auth] Password verification error:', err.message);
  }

  // Fallback to DASHBOARD_PASSWORD environment variable
  if (!DASHBOARD_PASSWORD) return false;
  return timingSafeEqualStr(String(password), String(DASHBOARD_PASSWORD));
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const valid = await redis.get('session:' + token);
      if (valid) {
        // Sliding expiration renewal (365 days) on active app use
        redis.expire('session:' + token, SESSION_TTL_SECONDS).catch(() => {});
        redis.sadd('auth:all_sessions', token).catch(() => {});
        req.authToken = token;
        return next();
      }
    }
  }

  // Also check query param token (e.g. for img tags requesting authenticated avatar assets)
  const queryToken = req.query?.token;
  if (queryToken && typeof queryToken === 'string') {
    const valid = await redis.get('session:' + queryToken);
    if (valid) {
      redis.expire('session:' + queryToken, SESSION_TTL_SECONDS).catch(() => {});
      req.authToken = queryToken;
      return next();
    }
  }

  // Fallback for x-pass header only (NO query parameters)
  const pass = req.headers['x-pass'];
  if (pass) {
    const ok = await verifyPassword(String(pass));
    if (ok) return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Invalid or expired token',
    code: 'UNAUTHORIZED',
    hint: 'Please sign in with your dashboard password to continue.'
  });
}

const router = express.Router();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

router.post('/login', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const attemptKey = `auth:attempts:${ip}`;

    // Rate limiting / Brute force protection: 5 attempts per 15 minutes per IP
    const rawAttempts = await redis.get(attemptKey);
    const attempts = parseInt(rawAttempts || '0', 10);
    if (attempts >= 5) {
      logEvent('warn', `Login rate limit exceeded from ${ip}`);
      return res.status(429).json({
        error: 'Too many failed login attempts. Temporarily blocked for 15 minutes.',
        code: 'TOO_MANY_ATTEMPTS',
        hint: 'Please wait 15 minutes before attempting to sign in again.'
      });
    }

    const { password } = req.body;
    const isValid = await verifyPassword(password);

    if (!isValid) {
      await redis.incr(attemptKey);
      await redis.expire(attemptKey, 900); // 15 minutes lockout window
      logEvent('warn', `Failed login attempt from IP ${ip} (Attempt ${attempts + 1}/5)`);
      return res.status(401).json({
        error: 'Incorrect dashboard password',
        code: 'INVALID_CREDENTIALS',
        hint: 'Please re-enter your dashboard password.'
      });
    }

    // Reset failed attempts on success
    await redis.del(attemptKey);

    const token = crypto.randomBytes(32).toString('hex');
    await Promise.all([
      redis.set('session:' + token, '1', { ex: SESSION_TTL_SECONDS }),
      redis.sadd('auth:all_sessions', token)
    ]);

    logEvent('info', 'Dashboard authenticated successfully. 365-day session issued.');
    res.json({ success: true, token, sessionExpiresInDays: 365 });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'LOGIN_FAILED',
      hint: 'An unexpected error occurred during sign in. Check system logs.'
    });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({
        error: 'Current password is required',
        code: 'CURRENT_PASSWORD_MISSING'
      });
    }

    const isCurrentValid = await verifyPassword(currentPassword);
    if (!isCurrentValid) {
      return res.status(401).json({
        error: 'Current password is incorrect',
        code: 'INCORRECT_CURRENT_PASSWORD',
        hint: 'Please verify your existing dashboard password before changing.'
      });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({
        error: 'New password must be at least 6 characters long',
        code: 'PASSWORD_TOO_SHORT'
      });
    }

    // Generate salted scrypt hash
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    await redis.set('auth:password_hash', `${salt}:${hash}`);

    logEvent('info', 'Dashboard password was successfully changed.');
    res.json({
      success: true,
      message: 'Dashboard password changed successfully'
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHANGE_PASSWORD_FAILED',
      hint: 'Failed to update password in Redis.'
    });
  }
});

router.post('/signout', requireAuth, async (req, res) => {
  try {
    const token = req.authToken;
    if (token) {
      await Promise.all([
        redis.del('session:' + token),
        redis.srem('auth:all_sessions', token)
      ]);
    }
    logEvent('info', 'Dashboard session signed out on this device.');
    res.json({ success: true, message: 'Signed out on this device' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/signout-all', requireAuth, async (req, res) => {
  try {
    const allTokens = await redis.smembers('auth:all_sessions');
    if (Array.isArray(allTokens) && allTokens.length > 0) {
      const pipe = allTokens.map(t => redis.del('session:' + t));
      await Promise.all(pipe);
    }
    await redis.del('auth:all_sessions');
    logEvent('warn', 'All dashboard sessions invalidated by user request (Sign out all devices).');
    res.json({
      success: true,
      message: 'Signed out of all devices successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
